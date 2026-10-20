/**
 * Screen Privacy Shield - Regex Engine Unit Tests (node:test)
 * Covers every built-in rule: positive detection, validators, and
 * negative cases that must NOT produce matches.
 *
 * Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RegexEngine, luhnCheck, validateIBAN, validateSSN, validatePhone,
  validateJWT, verhoeffCheck, validateAbaRouting, shannonEntropy,
  validateConnString, validateGenericSecret, validateUPI, validateIFSC,
  validateGSTIN, validateVehicleReg, validateDrivingLicense,
  validateIndianMobile
} = require('../src/content/regex_engine.js');

function engine(extraCats = []) {
  const e = new RegexEngine();
  for (const c of extraCats) e.enabledCategories.add(c);
  return e;
}

function matchedRules(text, eng) {
  return (eng || engine()).findMatches(text).map(m => m.ruleId);
}

// ---------------- Validators ----------------

test('Luhn: valid cards pass', () => {
  assert.ok(luhnCheck('4111 1111 1111 1111'));
  assert.ok(luhnCheck('4539 1488 0343 6467'));
  assert.ok(luhnCheck('6011-1111-1111-1117'));
});

test('Luhn: invalid/random digits fail', () => {
  assert.ok(!luhnCheck('4111 1111 1111 1112'));
  assert.ok(!luhnCheck('1234 5678 9012 3456'));
  assert.ok(!luhnCheck('411111111111'));
});

test('IBAN: mod-97 checksum', () => {
  assert.ok(validateIBAN('GB29 NWBK 6016 1331 9268 19'));
  assert.ok(validateIBAN('DE89370400440532013000'));
  assert.ok(!validateIBAN('GB29 NWBK 6016 1331 9268 20'));
});

test('SSN: boundary validation', () => {
  assert.ok(validateSSN('078-05-1120'));
  assert.ok(!validateSSN('666-12-3456'));
  assert.ok(!validateSSN('000-45-6789'));
  assert.ok(!validateSSN('978-05-1120'));
  assert.ok(!validateSSN('078-00-1120'));
});

test('Phone: length and repetition guards', () => {
  assert.ok(validatePhone('+1 415-555-2671'));
  assert.ok(!validatePhone('0000000000'));
  assert.ok(!validatePhone('12345'));
});

test('JWT: header must decode to JSON with alg/typ', () => {
  assert.ok(validateJWT('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.sig'));
  assert.ok(!validateJWT('bm90LWpzb24.e30.sig'));
  assert.ok(!validateJWT('abc'));
});

test('Verhoeff: Aadhaar checksum', () => {
  assert.ok(verhoeffCheck('234123418784'));      // valid checksum
  assert.ok(verhoeffCheck('2341 2341 8784'));    // spaced form
  assert.ok(!verhoeffCheck('234123418785'));     // bad check digit
  assert.ok(!verhoeffCheck('123412341234'));     // starts with 1 + bad checksum
});

test('ABA routing: 3-7-1 checksum + district', () => {
  assert.ok(validateAbaRouting('021000021'));    // JPMorgan Chase
  assert.ok(validateAbaRouting('011401533'));    // Wells Fargo
  assert.ok(!validateAbaRouting('123456789'));
  assert.ok(!validateAbaRouting('991000021'));   // invalid district
});

test('UPI: handle allowlist', () => {
  assert.ok(validateUPI('abhay.j@okhdfcbank'));
  assert.ok(validateUPI('merchant@paytm'));
  assert.ok(!validateUPI('user@gmail'));          // email-like handle rejected
  assert.ok(!validateUPI('someone@randombank'));
});

test('IFSC: bank prefix table', () => {
  assert.ok(validateIFSC('HDFC0001234'));
  assert.ok(validateIFSC('SBIN0059317'));
  assert.ok(!validateIFSC('XXXX0001234'));
  assert.ok(!validateIFSC('HDFC1001234'));       // 5th char must be 0
});

test('Connection strings must embed credentials', () => {
  assert.ok(validateConnString('mongodb+srv://user:p4ss@cluster.mongodb.net/db'));
  assert.ok(validateConnString('postgres://admin:secret@db.internal:5432/app'));
  assert.ok(!validateConnString('https://example.com/page'));
  assert.ok(!validateConnString('redis://localhost:6379'));
});

test('Generic secret: entropy + placeholder guards', () => {
  assert.ok(validateGenericSecret('api_key = "xk7jQp9zLm3nR8sT2vY5wB4cF6hJ"'));
  assert.ok(!validateGenericSecret('password = "changeme"'));
  assert.ok(!validateGenericSecret('secret=aaaaaaaaaa'));
});

test('Shannon entropy sanity', () => {
  assert.ok(shannonEntropy('aaaaaaaaaa') < 1);
  assert.ok(shannonEntropy('xk7jQp9zLm3nR8sT2vY5') > 3);
});

// ---------------- Engine-level detection ----------------

test('detects credit card in prose', () => {
  const m = matchedRules('Pay with card 4111 1111 1111 1111 today');
  assert.ok(m.includes('CREDIT_CARD'));
});

test('does not flag random 16 digits as card', () => {
  const m = matchedRules('Order ID: 1234 5678 9012 3456 confirmed');
  assert.ok(!m.includes('CREDIT_CARD'));
});

test('detects SSN and email', () => {
  const m = matchedRules('SSN 078-05-1120, reach jane.doe@example.com');
  assert.ok(m.includes('SSN'));
  assert.ok(m.includes('EMAIL'));
});

test('detects AWS + GitHub + Stripe + Google keys', () => {
  const m = matchedRules(
    'AKIAIOSFODNN7EXAMPLE and ghp_' + 'a'.repeat(36) +
    ' and ' + ('sk' + '_live_' + '4eC39HqLyjWDarjtT1zdp7dc') + ' and AIzaSyC4P0PAMPLE_KEY_1234567890abc'
  );
  assert.ok(m.includes('AWS_KEY'));
  assert.ok(m.includes('GITHUB_TOKEN'));
  assert.ok(m.includes('STRIPE_KEY'));
  assert.ok(m.includes('GOOGLE_KEY'));
});

test('detects OpenAI-style sk- key', () => {
  const m = matchedRules('openai key: sk-proj-xk7jQp9zLm3nR8sT2vY5wB4cF6hJ7kM');
  assert.ok(m.includes('OPENAI_KEY'));
});

test('detects Slack token', () => {
  const m = matchedRules('slack: xoxb-1234567890123-abcdefghijklm');
  assert.ok(m.includes('SLACK_TOKEN'));
});

test('detects JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const m = matchedRules('token: ' + jwt);
  assert.ok(m.includes('JWT'));
});

test('detects private key block', () => {
  const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----';
  const m = matchedRules(text);
  assert.ok(m.includes('PRIVATE_KEY'));
});

test('detects credentialed connection string', () => {
  const m = matchedRules('db at mongodb+srv://svc:Hunter22abc@cluster0.mongodb.net/prod');
  assert.ok(m.includes('CONN_STRING'));
});

test('detects URL with embedded credentials', () => {
  const m = matchedRules('fetch https://deploy:s3cr3tpass@internal.ci/job');
  assert.ok(m.includes('CONN_STRING'));
});

test('does not flag plain https URL', () => {
  const m = matchedRules('docs at https://example.com/guide/setup');
  assert.ok(!m.includes('CONN_STRING'));
});

test('detects Aadhaar + PAN + UPI + IFSC (Indian PII pack)', () => {
  const text = 'Aadhaar 2341 2341 8784, PAN ABCDE1234F, pay me at ravi.k@okicici, IFSC HDFC0001234';
  const m = matchedRules(text);
  assert.ok(m.includes('AADHAAR'));
  assert.ok(m.includes('PAN'));
  assert.ok(m.includes('UPI'));
  assert.ok(m.includes('IFSC'));
});

test('PAN format must be exact', () => {
  const m = matchedRules('code ABCD1234F and ABCDE12345');
  assert.ok(!m.includes('PAN'));
});

test('GSTIN: NIC mod-36 checksum', () => {
  assert.ok(validateGSTIN('27AAPFU0939F1ZV'));   // documented valid GSTIN
  assert.ok(validateGSTIN('29ABCDE1234F1ZW'));
  assert.ok(!validateGSTIN('27AAPFU0939F1ZT'));  // bad check char
  assert.ok(!validateGSTIN('27AAPFU0939F125'));  // reserved char must be Z
  assert.ok(!validateGSTIN('ABCDE1234F1ZV'));    // wrong length
});

test('Vehicle reg: Indian state codes', () => {
  assert.ok(validateVehicleReg('KA01AB1234'));
  assert.ok(validateVehicleReg('MH 12 DE 1433'));
  assert.ok(validateVehicleReg('DL8CAF1234'));
  assert.ok(!validateVehicleReg('XX01AB1234'));  // not a state code
  assert.ok(!validateVehicleReg('K101AB1234'));  // state must be 2 letters
});

test('Driving licence: state + year sanity', () => {
  assert.ok(validateDrivingLicense('KA0120110123456'));
  assert.ok(validateDrivingLicense('MH-14-2011-0012345'));
  assert.ok(!validateDrivingLicense('XX0120110123456'));
  assert.ok(!validateDrivingLicense('KA0118990123456'));  // year too old
  assert.ok(!validateDrivingLicense('KA0120990123456'));  // future year
});

test('Indian mobile: +91 / 0 / bare 10-digit forms', () => {
  assert.ok(validateIndianMobile('+91 98765 43210'));
  assert.ok(validateIndianMobile('09876543210'));
  assert.ok(validateIndianMobile('9876543210'));
  assert.ok(validateIndianMobile('91-8765432109'));
  assert.ok(!validateIndianMobile('1234567890'));  // must start 6-9
  assert.ok(!validateIndianMobile('987654321'));   // 9 digits
});

test('detects India pack: GSTIN + vehicle + DL + voter ID + mobile', () => {
  const text = 'GSTIN 27AAPFU0939F1ZV, car KA01AB1234, DL MH-14-2011-0012345, voter EPIC ABC1234567, call +91 98765 43210';
  const m = matchedRules(text);
  assert.ok(m.includes('GSTIN'));
  assert.ok(m.includes('VEHICLE_REG'));
  assert.ok(m.includes('DRIVING_LICENSE'));
  assert.ok(m.includes('VOTER_ID'));
  assert.ok(m.includes('IN_PHONE'));
});

test('IN_PHONE does not flag years or short numbers', () => {
  const m = matchedRules('met in 2019 at gate 4, code 12345, ext 98765');
  assert.ok(!m.includes('IN_PHONE'));
});

test('detects ABA routing number', () => {
  const m = matchedRules('Routing: 021000021 Account: 9988776655');
  assert.ok(m.includes('ABA_ROUTING'));
});

test('detects generic secret assignment', () => {
  const m = matchedRules('AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCY"');
  assert.ok(m.includes('GENERIC_SECRET'));
});

test('does not flag placeholder secrets', () => {
  const m = matchedRules('api_key = "your-api-key-here"');
  assert.ok(!m.includes('GENERIC_SECRET'));
});

test('ENTROPY category is opt-in', () => {
  const tok = 'xk7jQp9zLm3nR8sT2vY5wB4cF6hJ8nM3';
  assert.ok(!matchedRules(tok).includes('HIGH_ENTROPY'));           // default off
  assert.ok(matchedRules(tok, engine(['ENTROPY'])).includes('HIGH_ENTROPY'));
});

test('non-overlap: higher-priority rule wins on same span', () => {
  // GitHub PAT would also be a high-entropy string; PAT must win
  const pat = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  assert.equal(pat.length, 40);
  const matches = engine(['ENTROPY']).findMatches(pat);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ruleId, 'GITHUB_TOKEN');
});

test('custom regex rules integrate', () => {
  const e = engine();
  e.configure(null, [{
    pattern: '\\bEMP-\\d{6}\\b', category: 'API_KEY', badge: '🆔 EMP'
  }]);
  const m = e.findMatches('employee EMP-004213 onboarded');
  assert.equal(m[0].ruleId.includes('custom') || m[0].badge === '🆔 EMP', true);
});

test('category disable removes matches', () => {
  const e = new RegexEngine();
  e.configure({ EMAIL: { enabled: false } }, []);
  const m = e.findMatches('mail me at jane@example.com');
  assert.equal(m.length, 0);
});

test('empty/short text returns no matches', () => {
  assert.deepEqual(engine().findMatches(''), []);
  assert.deepEqual(engine().findMatches('hi'), []);
  assert.deepEqual(engine().findMatches(null), []);
});
