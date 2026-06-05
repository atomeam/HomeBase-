// Param validation + secret scanner

const SECRET_PATTERNS = /ntn_|sk-|ghp_|bearer|password|token|secret|key/i;

function scanForSecrets(params) {
  const str = JSON.stringify(params);
  if (SECRET_PATTERNS.test(str)) {
    return true;
  }
  return false;
}

function validateParams(params, schema) {
  const errors = [];
  
  // Check required
  for (const key of schema.required || []) {
    if (!params.hasOwnProperty(key)) {
      errors.push(`missing required: ${key}`);
    }
  }
  
  // Check types and ranges
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (params.hasOwnProperty(key)) {
      const val = params[key];
      
      // Type check
      if (spec.type === 'string' && typeof val !== 'string') {
        errors.push(`${key}: must be string`);
      }
      if (spec.type === 'number' && typeof val !== 'number') {
        errors.push(`${key}: must be number`);
      }
      
      // String constraints
      if (typeof val === 'string') {
        if (spec.minLength && val.length < spec.minLength) {
          errors.push(`${key}: too short (min ${spec.minLength})`);
        }
        if (spec.maxLength && val.length > spec.maxLength) {
          errors.push(`${key}: too long (max ${spec.maxLength})`);
        }
        if (spec.enum && !spec.enum.includes(val)) {
          errors.push(`${key}: must be one of ${spec.enum.join(', ')}`);
        }
      }
    }
  }
  
  return errors;
}

module.exports = { scanForSecrets, validateParams };
