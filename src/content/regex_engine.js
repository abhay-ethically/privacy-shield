/**
 * Screen Privacy Shield - Regex Detection Engine
 * High-performance tier-1 structured PII & secret detection with
 * algorithmic validation: Luhn (mod 10), IBAN (ISO 7064 mod-97),
 * SSN boundaries, JWT structure, Verhoeff (Aadhaar), ABA routing,
 * Shannon entropy for generic secrets.
 */

(function (global) {
  'use strict';

  // --- Algorithmic Validators ---

  /**
   * Luhn Algorithm (mod 10) for Credit Card Number verification
   */
  function luhnCheck(value) {
    const sanitized = value.replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(sanitized)) return false;

    let sum = 0;
    let shouldDouble = false;
    for (let i = sanitized.length - 1; i >= 0; i--) {
      let digit = parseInt(sanitized.charAt(i), 10);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
  }

  /**
   * ISO 7064 Mod-97-10 validation for International Bank Account Numbers (IBAN)
   */
  function validateIBAN(input) {
    const code = input.toUpperCase().replace(/[\s-]/g, '');
    if (code.length < 15 || code.length > 34) return false;

    const rearranged = code.slice(4) + code.slice(0, 4);

    let numStr = '';
    for (let i = 0; i < rearranged.length; i++) {
      const charCode = rearranged.charCodeAt(i);
      if (charCode >= 65 && charCode <= 90) {
        numStr += (charCode - 55).toString();
      } else if (charCode >= 48 && charCode <= 57) {
        numStr += rearranged[i];
      } else {
        return false;
      }
    }

    try {
      return BigInt(numStr) % 97n === 1n;
    } catch (e) {
      return false;
    }
  }

  /**
   * US Social Security Number boundary validation
   */
  function validateSSN(value) {
    const sanitized = value.replace(/[\s-]/g, '');
    if (sanitized.length !== 9) return false;
    const area = sanitized.substring(0, 3);
    const group = sanitized.substring(3, 5);
    const serial = sanitized.substring(5, 9);

    if (area === '000' || area === '666' || area.startsWith('9')) return false;
    if (group === '00') return false;
    if (serial === '0000') return false;
    return true;
  }

  /**
   * Phone Number validation: avoid matching isolated numbers or years
   */
  function validatePhone(value) {
    const digitsOnly = value.replace(/\D/g, '');
    if (digitsOnly.length < 7 || digitsOnly.length > 15) return false;
    if (/^(\d)\1+$/.test(digitsOnly)) return false;
    return true;
  }

  /**
   * JWT validation: header segment decodes to JSON containing 'alg' or 'typ'
   */
  function validateJWT(token) {
    const parts = token.split('.');
    if (parts.length < 2 || parts.length > 3) return false;
    try {
      let b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decoded = atob(b64);
      return decoded.includes('"alg"') || decoded.includes('"typ"');
    } catch (e) {
      return false;
    }
  }

  /**
   * Verhoeff checksum - validates Indian Aadhaar numbers (12 digits)
   */
  const VERHOEFF_D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
  ];
  const VERHOEFF_P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
  ];

  function verhoeffCheck(value) {
    const digits = value.replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(digits)) return false;
    // Aadhaar numbers cannot start with 0 or 1
    if (digits[0] === '0' || digits[0] === '1') return false;
    let c = 0;
    for (let i = 0; i < digits.length; i++) {
      const d = parseInt(digits[digits.length - 1 - i], 10);
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][d]];
    }
    return c === 0;
  }

  /**
   * ABA routing number checksum (US bank routing): weights 3,7,1 repeating
   */
  function validateAbaRouting(value) {
    const d = value.replace(/\D/g, '');
    if (d.length !== 9) return false;
    const prefix = parseInt(d.substring(0, 2), 10);
    // Valid Fed districts: 01-12, 21-32, 61-72, 80
    const valid = (prefix >= 1 && prefix <= 12) ||
                  (prefix >= 21 && prefix <= 32) ||
                  (prefix >= 61 && prefix <= 72) ||
                  prefix === 80;
    if (!valid) return false;
    const weights = [3, 7, 1];
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += parseInt(d[i], 10) * weights[i % 3];
    }
    return sum % 10 === 0;
  }

  // Indian state/UT codes for vehicle & licence validation
  const IN_STATE_CODES = new Set([
    'AP','AR','AS','BR','CG','CH','DD','DL','DN','GA','GJ','HP','HR','JH',
    'JK','KA','KL','LA','LD','MH','ML','MN','MP','MZ','NL','OD','PB','PY',
    'RJ','SK','TG','TN','TR','TS','UK','UP','UT','WB','AN','BH','LD','LK'
  ]);

  const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /**
   * GSTIN checksum (NIC mod-36 algorithm):
   * odd positions (1st,3rd,...) * 1, even positions * 2;
   * contribution = floor(product/36) + (product mod 36);
   * check char = (36 - sum % 36) % 36.
   */
  function validateGSTIN(value) {
    const v = value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return false;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const c = GSTIN_CHARS.indexOf(v[i]);
      const f = (i % 2 === 0) ? 1 : 2;
      const p = c * f;
      sum += Math.floor(p / 36) + (p % 36);
    }
    const check = (36 - (sum % 36)) % 36;
    return v[14] === GSTIN_CHARS[check];
  }

  /** Indian vehicle registration: KA01AB1234 / MH 12 DE 1433 */
  function validateVehicleReg(value) {
    const v = value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/.test(v)) return false;
    if (v.length < 8) return false;
    return IN_STATE_CODES.has(v.substring(0, 2));
  }

  /** Indian driving licence: state code + RTO + year + serial */
  function validateDrivingLicense(value) {
    const v = value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}\d{4}\d{6,7}$/.test(v)) return false;
    const year = parseInt(v.substring(4, 8), 10);
    if (year < 1950 || year > new Date().getFullYear() + 1) return false;
    return IN_STATE_CODES.has(v.substring(0, 2));
  }

  /** Indian mobile: 10 digits starting 6-9, optional +91/91/0 prefix */
  function validateIndianMobile(value) {
    const v = value.replace(/[\s-]/g, '');
    const m = v.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
    return !!m;
  }

  /**
   * Shannon entropy (bits/char) - used to reject low-entropy generic matches
   */
  function shannonEntropy(str) {
    if (!str) return 0;
    const freq = {};
    for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
    let entropy = 0;
    const len = str.length;
    for (const k in freq) {
      const p = freq[k] / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /** Require entropy >= 3.5 bits/char for generic token-ish strings */
  function entropyGate(min) {
    return (value) => shannonEntropy(value) >= min;
  }

  /** Connection string must embed credentials (user:pass@host) */
  function validateConnString(value) {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value);
  }

  /**
   * Generic secret assignment: key=value pair where value is high-entropy
   */
  function validateGenericSecret(value) {
    const m = value.match(/[:=]\s*["']?([^\s"']{8,})/);
    if (!m) return false;
    const secret = m[1].replace(/["'`;,)\]}]+$/, '');
    if (secret.length < 8) return false;
    if (shannonEntropy(secret) < 3.0) return false;
    // Reject obvious placeholders
    if (/^(your|xxx|test|example|sample|changeme|placeholder|redacted)/i.test(secret)) {
      return false;
    }
    return true;
  }

  /**
   * High-entropy standalone string detection (Shannon >= 4.5)
   */
  function validateHighEntropy(value) {
    const v = value.trim();
    if (v.length < 28) return false;
    if (shannonEntropy(v) < 4.7) return false;
    // Reject pure dictionary words / prose and all-numeric sequences
    if (/^[a-z\s]+$/.test(v)) return false;
    if (/^\d+$/.test(v)) return false;
    return true;
  }

  /**
   * UPI ID validation: local-part@handle where handle is a known PSP
   */
  const UPI_HANDLES = /^(?:upi|ok(?:hdfcbank|icici|sbi|axis)|paytm|ybl|okbizaxis|okaxis|okicici|oksbi|axl|ibl|airtel|payzapp|fbl|freecharge|jio|wa(?:xis|hdfcbank|icici|sbi)|cpt|barodampay|boi|canarabank|citi|cnrb|dlb|dbs|equitas|esaf|federal|finobank|hsbc|idbi|idfc|idfcnetc|imobile|indus|iob|jkb|jsb|karur|kaypay|kbl|kb?vgb|kotak|lvb|mahb|myicici|pingpay|pnb|rbl|sib|srcb|timecosmos|uboi|uco|ujjivan|unionbank|utkarsh|yesbank)$/i;

  function validateUPI(value) {
    const at = value.lastIndexOf('@');
    if (at < 2) return false;
    const handle = value.slice(at + 1);
    return UPI_HANDLES.test(handle);
  }

  /**
   * IFSC: 4 bank letters + '0' + 6 branch chars, checked against known banks
   */
  const IFSC_BANKS = new Set([
    'SBIN','HDFC','ICIC','PUNB','BARB','UBIN','CNRB','BKID','IOBA','CBIN',
    'IDIB','KKBK','UTIB','YESB','INDB','FDRL','KVGB','MAHB','SBBJ','CORP',
    'ALLA','ANDB','VIJB','ORBC','UCBA','CSBK','DCBL','ESAF','FINO','HSBC',
    'CITI','DEUT','DBSS','SCBL','RATN','SIBL','TMBL','KARB','JAKA','IDFB',
    'AUBL','ESMF','UJVN','NKGS','SRCB','BDBL','IBKL','PJSB','GSCB','ICIC'
  ]);

  function validateIFSC(value) {
    const code = value.trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return false;
    return IFSC_BANKS.has(code.substring(0, 4));
  }

  // --- Rule Definitions ---
  const BUILT_IN_RULES = [
    {
      id: 'PRIVATE_KEY',
      name: 'Private Key Block',
      category: 'PRIVATE_KEY',
      badge: '🚨 PRIV KEY',
      color: '#dc2626',
      regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{10,2000}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
      validate: null,
      priority: 100
    },
    {
      id: 'CREDIT_CARD',
      name: 'Credit Card',
      category: 'CREDIT_CARD',
      badge: '💳 CARD',
      color: '#f43f5e',
      regex: /\b(?:4\d{3}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}|5[1-5]\d{2}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}|3[47]\d{2}[ -]?\d{6}[ -]?\d{5}|6(?:011|5\d{2})[ -]?\d{4}[ -]?\d{4}[ -]?\d{4})\b/g,
      validate: luhnCheck,
      priority: 90
    },
    {
      id: 'SSN',
      name: 'US SSN',
      category: 'SSN',
      badge: '🔒 SSN',
      color: '#ef4444',
      regex: /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
      validate: validateSSN,
      priority: 85
    },
    {
      id: 'EMAIL',
      name: 'Email Address',
      category: 'EMAIL',
      badge: '✉️ EMAIL',
      color: '#3b82f6',
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      validate: null,
      priority: 70
    },
    {
      id: 'IBAN',
      name: 'Bank Account (IBAN)',
      category: 'IBAN',
      badge: '🏦 IBAN',
      color: '#06b6d4',
      regex: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/gi,
      validate: validateIBAN,
      priority: 80
    },
    {
      id: 'AADHAAR',
      name: 'Aadhaar Number',
      category: 'AADHAAR',
      badge: '🪪 AADHAAR',
      color: '#ea580c',
      regex: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      validate: verhoeffCheck,
      priority: 88
    },
    {
      id: 'PAN',
      name: 'PAN Card',
      category: 'PAN',
      badge: '🪪 PAN',
      color: '#d97706',
      regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
      validate: null,
      priority: 82
    },
    {
      id: 'UPI',
      name: 'UPI ID',
      category: 'UPI',
      badge: '💸 UPI',
      color: '#059669',
      regex: /\b[a-zA-Z0-9][a-zA-Z0-9._-]{1,49}@[a-zA-Z]{2,20}\b/g,
      validate: validateUPI,
      priority: 72
    },
    {
      id: 'IFSC',
      name: 'Bank IFSC Code',
      category: 'IFSC',
      badge: '🏦 IFSC',
      color: '#0891b2',
      regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
      validate: validateIFSC,
      priority: 65
    },
    {
      id: 'ABA_ROUTING',
      name: 'US Bank Routing (ABA)',
      category: 'ROUTING',
      badge: '🏦 ROUTING',
      color: '#0d9488',
      regex: /\b\d{9}\b/g,
      validate: validateAbaRouting,
      priority: 50
    },
    {
      id: 'GSTIN',
      name: 'GSTIN (India)',
      category: 'GSTIN',
      badge: '🧾 GSTIN',
      color: '#c2410c',
      regex: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g,
      validate: validateGSTIN,
      priority: 84
    },
    {
      id: 'VEHICLE_REG',
      name: 'Vehicle Registration (India)',
      category: 'VEHICLE_REG',
      badge: '🚗 VEHICLE',
      color: '#0369a1',
      regex: /\b[A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4}\b/g,
      validate: validateVehicleReg,
      priority: 55
    },
    {
      id: 'DRIVING_LICENSE',
      name: 'Driving Licence (India)',
      category: 'DRIVING_LICENSE',
      badge: '🪪 DL',
      color: '#9333ea',
      regex: /\b[A-Z]{2}[\s-]?\d{2}[\s-]?\d{4}[\s-]?\d{6,7}\b/g,
      validate: validateDrivingLicense,
      priority: 58
    },
    {
      id: 'VOTER_ID',
      name: 'Voter ID / EPIC (India)',
      category: 'VOTER_ID',
      badge: '🗳️ VOTER ID',
      color: '#15803d',
      regex: /\b[A-Z]{3}\d{7}\b/g,
      validate: null,
      priority: 48
    },
    {
      id: 'IN_PHONE',
      name: 'Mobile Number (India)',
      category: 'PHONE',
      badge: '📞 MOBILE',
      color: '#10b981',
      regex: /\b(?:\+91[\s-]?|91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}\b/g,
      validate: validateIndianMobile,
      priority: 62
    },
    {
      id: 'PASSPORT',
      name: 'Passport Number',
      category: 'PASSPORT',
      badge: '🛂 PASSPORT',
      color: '#7c3aed',
      regex: /\b[A-PR-WY][1-9]\d{7}\b|\b[A-Z]\d{7}\b/g,
      validate: null,
      priority: 45
    },
    {
      id: 'AWS_KEY',
      name: 'AWS Access Key',
      category: 'API_KEY',
      badge: '🔑 AWS KEY',
      color: '#f59e0b',
      regex: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
      validate: null,
      priority: 95
    },
    {
      id: 'GITHUB_TOKEN',
      name: 'GitHub Token',
      category: 'API_KEY',
      badge: '🔑 GITHUB PAT',
      color: '#f59e0b',
      regex: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})\b/g,
      validate: null,
      priority: 95
    },
    {
      id: 'GOOGLE_KEY',
      name: 'Google API Key',
      category: 'API_KEY',
      badge: '🔑 GOOGLE KEY',
      color: '#f59e0b',
      regex: /\bAIza[0-9A-Za-z\-_]{30,45}\b/g,
      validate: null,
      priority: 95
    },
    {
      id: 'STRIPE_KEY',
      name: 'Stripe API Key',
      category: 'API_KEY',
      badge: '🔑 STRIPE KEY',
      color: '#f59e0b',
      regex: /\b[rs]k_(?:test|live)_[0-9a-zA-Z]{24,99}\b/g,
      validate: null,
      priority: 95
    },
    {
      id: 'OPENAI_KEY',
      name: 'OpenAI / Anthropic Key',
      category: 'API_KEY',
      badge: '🔑 AI KEY',
      color: '#f59e0b',
      regex: /\bsk-(?:proj-|ant-|admin-|svcacct-)?[A-Za-z0-9_-]{20,160}\b/g,
      validate: entropyGate(3.4),
      priority: 95
    },
    {
      id: 'SLACK_TOKEN',
      name: 'Slack Token',
      category: 'API_KEY',
      badge: '🔑 SLACK',
      color: '#f59e0b',
      regex: /\bxox[baprs]-[A-Za-z0-9-]{10,80}\b/g,
      validate: null,
      priority: 95
    },
    {
      id: 'NPM_TOKEN',
      name: 'NPM / PyPI Token',
      category: 'API_KEY',
      badge: '🔑 NPM',
      color: '#f59e0b',
      regex: /\bnpm_[A-Za-z0-9]{36}\b|\bpypi-[A-Za-z0-9_-]{50,}\b/g,
      validate: null,
      priority: 95
    },
    {
      id: 'JWT',
      name: 'JSON Web Token',
      category: 'JWT',
      badge: '🛡️ JWT',
      color: '#8b5cf6',
      regex: /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+\b/g,
      validate: validateJWT,
      priority: 75
    },
    {
      id: 'CONN_STRING',
      name: 'Connection String',
      category: 'CONNECTION_STRING',
      badge: '🗄️ CONN STR',
      color: '#be185d',
      regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis(?:\+sentinel)?|rediss|amqps?|kafka|elasticsearch|https?|ftp|sftp|smtp|ldap|jdbc:[a-z]+):\/\/[^\s"'<>]+/gi,
      validate: validateConnString,
      priority: 92
    },
    {
      id: 'CRED_URL',
      name: 'URL with Credentials',
      category: 'CONNECTION_STRING',
      badge: '🔗 CRED URL',
      color: '#be185d',
      regex: /\bhttps?:\/\/[^/\s:@]{1,64}:[^/\s@]{1,128}@[^\s"'<>]+/gi,
      validate: null,
      priority: 91
    },
    {
      id: 'GENERIC_SECRET',
      name: 'Secret Assignment',
      category: 'GENERIC_SECRET',
      badge: '🔐 SECRET',
      color: '#9333ea',
      regex: /(?<![A-Za-z0-9])(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|app[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|passwd|password|pwd|secret)\s*[:=]\s*["'`]?[A-Za-z0-9+/=_\-.@]{8,128}["'`]?/gi,
      validate: validateGenericSecret,
      priority: 78
    },
    {
      id: 'HIGH_ENTROPY',
      name: 'High-Entropy String',
      category: 'ENTROPY',
      badge: '⚡ ENTROPY',
      color: '#64748b',
      regex: /\b[A-Za-z0-9+/=_-]{24,128}\b/g,
      validate: validateHighEntropy,
      priority: 10
    },
    {
      id: 'PHONE',
      name: 'Phone Number',
      category: 'PHONE',
      badge: '📞 PHONE',
      color: '#10b981',
      regex: /(?:^|[\s(,;:])(?<phone>\+?\d{1,3}[-.\s]?(?:\(?\d{2,4}\)?[-.\s]?)\d{3}[-.\s]?\d{4})\b/g,
      validate: validatePhone,
      isGroupMatch: 'phone',
      priority: 60
    }
  ];

  class RegexEngine {
    constructor() {
      this.rules = [...BUILT_IN_RULES];
      this.enabledCategories = new Set([
        'CREDIT_CARD', 'SSN', 'EMAIL', 'PHONE', 'API_KEY', 'JWT', 'IBAN',
        'CUSTOM_SELECTOR', 'NER_ENTITY', 'OCR_TEXT', 'PRIVATE_KEY',
        'CONNECTION_STRING', 'GENERIC_SECRET', 'AADHAAR', 'PAN', 'UPI',
        'IFSC', 'PASSPORT', 'ROUTING', 'GSTIN', 'VEHICLE_REG',
        'DRIVING_LICENSE', 'VOTER_ID'
        // 'ENTROPY' intentionally off by default - high false-positive risk
      ]);
      this.customRules = [];
    }

    /**
     * Update active categories and custom rules from config
     */
    configure(categoriesConfig, customRegexRules) {
      if (categoriesConfig) {
        this.enabledCategories.clear();
        for (const [cat, conf] of Object.entries(categoriesConfig)) {
          if (conf && conf.enabled) {
            this.enabledCategories.add(cat);
          }
        }
      }

      this.customRules = [];
      if (Array.isArray(customRegexRules)) {
        for (const r of customRegexRules) {
          try {
            if (r.pattern) {
              const category = r.category || 'API_KEY';
              this.customRules.push({
                id: r.id || 'custom_' + Math.random().toString(36).substring(2, 7),
                name: r.name || 'Custom Pattern',
                category,
                badge: r.badge || '🔍 CUSTOM',
                color: r.color || '#ec4899',
                regex: new RegExp(r.pattern, r.flags || 'g'),
                validate: null,
                priority: r.priority || 50
              });
              // A custom rule whose category isn't declared in the
              // categories map would be silently filtered forever - treat
              // undeclared categories as enabled (user-authored rules).
              if (!categoriesConfig || !(category in categoriesConfig)) {
                this.enabledCategories.add(category);
              }
            }
          } catch (err) {
            console.warn('[ScreenShield] Invalid custom regex:', r.pattern, err);
          }
        }
      }
    }

    /**
     * Scans text string and returns non-overlapping matched ranges
     * @param {string} text - The raw text content of a text node
     * @returns {Array<{start: number, end: number, ruleId: string, category: string, badge: string, color: string, value: string}>}
     */
    findMatches(text) {
      if (!text || text.length < 3) return [];

      const activeRules = [...this.rules, ...this.customRules].filter(r =>
        this.enabledCategories.has(r.category)
      );

      const rawMatches = [];

      for (const rule of activeRules) {
        // Reset regex state
        rule.regex.lastIndex = 0;
        let match;
        let guard = 0;
        const MAX_ITER = 200; // guard against pathological/zero-width loops
        while ((match = rule.regex.exec(text)) !== null && guard++ < MAX_ITER) {
          let val = match[0];
          let start = match.index;

          if (rule.isGroupMatch && match.groups && match.groups[rule.isGroupMatch]) {
            val = match.groups[rule.isGroupMatch];
            const offset = match[0].indexOf(val);
            start = match.index + offset;
          }

          const end = start + val.length;

          // Prevent infinite loop on zero-width matches
          if (rule.regex.lastIndex === match.index) {
            rule.regex.lastIndex++;
          }

          // Run algorithmic validator if defined
          if (rule.validate && !rule.validate(val)) {
            continue;
          }

          rawMatches.push({
            start,
            end,
            length: val.length,
            ruleId: rule.id,
            category: rule.category,
            badge: rule.badge,
            color: rule.color,
            priority: rule.priority,
            value: val
          });
        }
      }

      if (rawMatches.length === 0) return [];

      // Sort by start index ascending, then priority descending, then length descending
      rawMatches.sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return b.length - a.length;
      });

      // Filter out overlapping matches (keep highest priority/first)
      const nonOverlapping = [];
      let lastEnd = -1;

      for (const m of rawMatches) {
        if (m.start >= lastEnd) {
          nonOverlapping.push(m);
          lastEnd = m.end;
        }
      }

      return nonOverlapping;
    }
  }

  // Export for browser & node test environments
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      RegexEngine, luhnCheck, validateIBAN, validateSSN, validatePhone,
      validateJWT, verhoeffCheck, validateAbaRouting, shannonEntropy,
      validateConnString, validateGenericSecret, validateHighEntropy,
      validateUPI, validateIFSC, validateGSTIN, validateVehicleReg,
      validateDrivingLicense, validateIndianMobile, BUILT_IN_RULES
    };
  } else {
    global.ScreenShieldRegexEngine = RegexEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
