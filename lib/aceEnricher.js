'use strict';

/**
 * ACE Enrichment Module
 *
 * Calls Geotab ACE (via GetAceResults) to:
 *   1. Assess severity and driver context
 *   2. Generate a natural-voice opening call script (≤ 30 seconds)
 *   3. Pre-cache 5 likely supervisor Q&A pairs
 *
 * ACE is called ONCE per exception, before the call is initiated.
 * This pre-caching means the live call loop can answer most
 * supervisor questions instantly without a live ACE roundtrip.
 *
 * IMPORTANT: ACE has a hard 500-character limit per prompt.
 * buildPrompt() is carefully designed to stay under 490 chars
 * after all dynamic values are substituted.
 */

// ─── Language display names for prompt context ────────────────────────────────
const LANG_NAMES = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese'   // shorter than "Brazilian Portuguese" — saves chars
};

// ─── Severity labels per language ─────────────────────────────────────────────
const SEVERITY_LABELS = {
  high:   { en: 'high',   es: 'alta',  pt: 'alta'  },
  medium: { en: 'medium', es: 'media', pt: 'média' },
  low:    { en: 'low',    es: 'baja',  pt: 'baixa' }
};

// ─── Build the ACE enrichment prompt ─────────────────────────────────────────
//
// ACE has a hard 500-character limit. Strategy:
//   - Use ultra-short field names and pipe separators instead of bullets
//   - Truncate all dynamic values to known max lengths
//   - Use compact JSON schema (keys on one line)
//   - Hard-slice at 490 as a safety net
//
// Template overhead (without dynamic values): ~250 chars
// Budget for dynamic values: ~240 chars
//   excType:    30 chars max
//   vehicle:    20 chars max
//   driver:     20 chars max
//   severity:    5 chars max
//   history:    20 chars max ("3 incidents" etc.)
//   langName:   10 chars max
// Total dynamic: ~105 chars → well within budget
//
function buildPrompt(exception, driver, recentEvents, lang, ruleSeverity) {
  const langName  = LANG_NAMES[lang] || LANG_NAMES.en;
  const severity  = (SEVERITY_LABELS[ruleSeverity]?.[lang] || ruleSeverity || 'medium').slice(0, 6);
  const driverName = (driver
    ? (`${driver.firstName || ''} ${driver.lastName || ''}`).trim() || driver.name || 'Unknown'
    : 'Unknown').slice(0, 15);
  const vehicle   = (exception.vehicleName || exception.vehicleId || 'Unknown').slice(0, 15);
  const excType   = (exception.exceptionName || 'Exception').slice(0, 25);
  const hist      = recentEvents.length ? `${recentEvents.length} prior incidents` : 'first occurrence';

  // Only ask ACE for severityAssessment and script — both require AI judgment.
  // cachedQA is built locally in enrichWithAce() using known data, so ACE
  // cannot return vague questions instead of real answers.
  const prompt =
`Complete JSON in ${langName}. Two fields only.
ctx:${excType}|${vehicle}|${driverName}|${severity}|${hist}
{"severityAssessment":"<1 sentence: how serious and why>","script":"<30s phone call in ${langName}: greet, vehicle ${vehicle}, exception ${excType}, ${hist}, ask supervisor for instructions>"}`
    .slice(0, 490);

  return prompt;
}

// ─── Localized string fragments used in fallback template ────────────────────
const L10N = {
  unknownDriver: {
    en: 'the assigned driver',
    es: 'el conductor asignado',
    pt: 'o motorista designado'
  },
  unknownVehicle: {
    en: 'a vehicle',
    es: 'un vehículo',
    pt: 'um veículo'
  },
  unknownException: {
    en: 'a fleet exception',
    es: 'una excepción de flota',
    pt: 'uma exceção de frota'
  }
};

// ─── Fallback script template (if ACE fails or returns unparseable response) ──
function buildFallbackScript(exception, driver, lang) {
  const l = (key) => L10N[key][lang] || L10N[key].en;

  const driverName = driver
    ? (`${driver.firstName || ''} ${driver.lastName || ''}`).trim() || l('unknownDriver')
    : l('unknownDriver');

  const vehicle = exception.vehicleName || exception.vehicleId || l('unknownVehicle');
  const excType = exception.exceptionName || l('unknownException');

  const localeMap = { en: 'en-US', es: 'es-MX', pt: 'pt-BR' };
  const locale    = localeMap[lang] || 'en-US';
  const time      = new Date(exception.dateTime || exception.activeFrom)
    .toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  const templates = {
    en: `Hello, this is an automated Fleet Voice Alert. A ${excType} exception was detected on ${vehicle} with driver ${driverName} at ${time}. Please say your question or press any key to get more details. Press star to dismiss this alert.`,
    es: `Hola, este es un alerta automático de flota. Se detectó una excepción de ${excType} en el vehículo ${vehicle} con el conductor ${driverName} a las ${time}. Diga su pregunta o presione cualquier tecla para obtener más detalles. Presione asterisco para descartar esta alerta.`,
    pt: `Olá, este é um alerta automático de frota. Uma exceção de ${excType} foi detectada no veículo ${vehicle} com o motorista ${driverName} às ${time}. Diga sua pergunta ou pressione qualquer tecla para obter mais detalhes. Pressione asterisco para descartar este alerta.`
  };

  return templates[lang] || templates.en;
}

// ─── Parse ACE JSON response ──────────────────────────────────────────────────
function parseAceResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Strip markdown code fences if ACE ignores our instruction
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Helper: accept any JSON with at least a script field
  // (cachedQA is now built locally — ACE only returns script + severityAssessment)
  const isValid = (p) => p && typeof p === 'object' && (p.script || p.severityAssessment);

  try {
    const parsed = JSON.parse(cleaned);
    if (isValid(parsed)) return parsed;
    return null;
  } catch {
    // Try to extract JSON substring if ACE added preamble text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (isValid(parsed)) return parsed;
      } catch { /* fall through */ }
    }
    return null;
  }
}

// ─── Main enrichment function ─────────────────────────────────────────────────
/**
 * @param {object} geotabClient  Authenticated GeotabClient instance
 * @param {object} exception     Matched exception event from GetFeed
 * @param {object} driver        Driver User object (may be null)
 * @param {Array}  recentEvents  Recent exception events for this driver/vehicle
 * @param {string} lang          'en' | 'es' | 'pt'
 * @param {string} ruleSeverity  'high' | 'medium' | 'low'
 * @returns {{ script, cachedQA, severityAssessment }}
 */
async function enrichWithAce(geotabClient, exception, driver, recentEvents, lang, ruleSeverity) {
  const prompt = buildPrompt(exception, driver, recentEvents, lang, ruleSeverity);
  console.log(`[ACE] Prompt length: ${prompt.length} chars for exception ${exception.id}`);

  // ── Build cachedQA locally — do NOT rely on ACE for these ──────────────────
  // ACE doesn't have fleet data to answer "what should I do?" or "where is it?"
  // so it returns vague questions. Build answers from known context instead.
  const driverName = driver
    ? (`${driver.firstName || ''} ${driver.lastName || ''}`).trim() || driver.name || null
    : null;
  const vehicle    = exception.vehicleName || exception.vehicleId || 'Unknown';
  const excType    = exception.exceptionName || 'Exception';
  const hist       = recentEvents.length
    ? `No, this vehicle has triggered ${recentEvents.length} incidents in the last 7 days.`
    : 'Yes, this appears to be the first occurrence in the last 7 days.';

  const actionMap = {
    high:   { en: 'Contact the driver immediately and consider pulling the vehicle off route.',
               es: 'Contacte al conductor de inmediato y considere retirar el vehículo de la ruta.',
               pt: 'Contate o motorista imediatamente e considere retirar o veículo da rota.' },
    medium: { en: 'Contact the driver to remind them of speed policies and log the incident.',
               es: 'Contacte al conductor para recordarle las políticas de velocidad y registre el incidente.',
               pt: 'Contate o motorista para lembrá-lo das políticas de velocidade e registre o incidente.' },
    low:    { en: 'Log the incident and monitor for repeated violations.',
               es: 'Registre el incidente y monitoree si hay infracciones repetidas.',
               pt: 'Registre o incidente e monitore se há violações repetidas.' }
  };

  const seriousMap = {
    high:   { en: `High severity: ${excType} on ${vehicle} poses an immediate safety risk and requires urgent action.`,
               es: `Severidad alta: ${excType} en ${vehicle} representa un riesgo inmediato de seguridad.`,
               pt: `Alta severidade: ${excType} em ${vehicle} representa um risco imediato de segurança.` },
    medium: { en: `Medium severity: ${excType} on ${vehicle} is a compliance concern, especially with repeated occurrences.`,
               es: `Severidad media: ${excType} en ${vehicle} es un problema de cumplimiento, especialmente con ocurrencias repetidas.`,
               pt: `Severidade média: ${excType} em ${vehicle} é uma preocupação de conformidade.` },
    low:    { en: `Low severity: ${excType} on ${vehicle} is a minor infraction worth monitoring.`,
               es: `Severidad baja: ${excType} en ${vehicle} es una infracción menor que vale la pena monitorear.`,
               pt: `Baixa severidade: ${excType} em ${vehicle} é uma infração menor a ser monitorada.` }
  };

  const l = (map) => map[ruleSeverity]?.[lang] || map.medium?.[lang] || map.medium.en;

  const cachedQA = {
    'location?':   'Real-time location not available in the alert. Ask again during the call for live GPS data.',
    'driver info?': driverName ? `The driver is ${driverName}.` : 'Driver information is not available for this vehicle.',
    'first time?':  hist,
    'action?':      l(actionMap),
    'how serious?': l(seriousMap)
  };

  // ── Ask ACE only for severityAssessment and script ─────────────────────────
  let aceResult = null;
  try {
    const raw = await geotabClient.callAceStateful(prompt);
    aceResult = parseAceResponse(raw);
    if (!aceResult) {
      // ACE returned text but not valid JSON with script field.
      // Try one more time: sometimes ACE wraps the JSON in extra text/quotes.
      const doubleUnwrap = raw ? raw.replace(/^["']|["']$/g, '').trim() : '';
      const inner = parseAceResponse(doubleUnwrap);
      if (inner) {
        aceResult = inner;
        console.log(`[ACE] Unwrapped quoted JSON for ${exception.id}`);
      } else if (raw && raw.length > 30 && !raw.includes('"script"')) {
        // Genuine plain text response — use as script directly
        console.warn(`[ACE] Plain text response for ${exception.id} — using as script`);
        aceResult = { severityAssessment: '', script: raw.trim().slice(0, 500) };
      } else {
        // Raw contains JSON keys but failed to parse — use fallback, don't corrupt script
        console.warn(`[ACE] Could not parse response for ${exception.id} — using fallback`);
      }
    }
  } catch (err) {
    console.error(`[ACE] Call failed for exception ${exception.id}:`, err.message);
  }

  const rawScript = aceResult?.script || buildFallbackScript(exception, driver, lang);

  return {
    severityAssessment: aceResult?.severityAssessment || '',
    script:             cleanScript(rawScript),
    cachedQA
  };
}

// ─── Clean ACE-generated script placeholders ─────────────────────────────────
// ACE sometimes inserts "[Your Name]", "[Supervisor's Name]", "[Company]" etc.
// Replace with system identity or remove gracefully.
function cleanScript(script) {
  if (!script) return script;
  return script
    // Name placeholders → system identity
    .replace(/\[Your Name\]/gi,         'Fleet Voice Alert System')
    .replace(/\[Supervisor'?s? Name\]/gi,'Fleet Voice Alert System')
    .replace(/\[Caller Name\]/gi,        'Fleet Voice Alert System')
    .replace(/\[Agent Name\]/gi,         'Fleet Voice Alert System')
    // Company/org placeholders → system identity
    .replace(/\[Company(?: Name)?\]/gi,  'Fleet Voice Alert System')
    .replace(/\[Organization\]/gi,       'Fleet Voice Alert System')
    // Date/time placeholders → remove
    .replace(/\[Date(?:\/Time)?\]/gi,    '')
    .replace(/\[Time\]/gi,               '')
    // Any remaining square-bracket placeholders → remove
    .replace(/\[[^\]]{1,40}\]/g,         '')
    // Clean up double spaces left by removals
    .replace(/  +/g, ' ')
    .trim();
}
module.exports = { enrichWithAce, buildFallbackScript };