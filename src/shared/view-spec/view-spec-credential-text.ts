/** Detects credential-shaped wording so a view field cannot be used to phish for secrets. */

const CREDENTIAL_TRIGGER =
  '(pass(word|phrase)?|secret\\s?key|secret|token|api\\s?key|credential|private\\s?key)'
const CREDENTIAL_PATTERN = new RegExp(`\\b${CREDENTIAL_TRIGGER}\\b`, 'i')
const CREDENTIAL_SUBSTRING_PATTERN = new RegExp(CREDENTIAL_TRIGGER, 'i')

// a capital run against a lowercase run (`DBpassword`) has no marker for where the trailing word
// starts, so both splits are checked
function credentialCandidates(value: string): string[] {
  const withoutSeparators = value.replace(/[_-]+/g, ' ')
  const finishSplit = (candidate: string): string =>
    candidate
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
  return [
    finishSplit(withoutSeparators.replace(/([A-Z]+)(?=[A-Z][a-z])/g, '$1 ')),
    finishSplit(withoutSeparators.replace(/([A-Z]+)([a-z])/g, '$1 $2'))
  ]
}

/** True when `value` names a password, token, key or similar secret, in any casing or separator style. */
export function mentionsCredential(value: string): boolean {
  return credentialCandidates(value).some((normalized) => {
    if (CREDENTIAL_PATTERN.test(normalized)) {
      return true
    }
    // an unbroken capital run (MYSECRET) has no internal boundary for \b
    return normalized
      .split(' ')
      .some((word) => /^[A-Z0-9]+$/.test(word) && CREDENTIAL_SUBSTRING_PATTERN.test(word))
  })
}
