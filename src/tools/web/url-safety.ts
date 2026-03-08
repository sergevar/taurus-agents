/**
 * URL safety validation — prevents SSRF attacks by rejecting
 * private IPs, internal hostnames, and non-HTTP schemes.
 */

const PRIVATE_IP_PATTERNS = [
  /^127\./,                          // 127.0.0.0/8 loopback
  /^10\./,                           // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,     // 172.16.0.0/12
  /^192\.168\./,                     // 192.168.0.0/16
  /^169\.254\./,                     // 169.254.0.0/16 link-local
  /^0\./,                            // 0.0.0.0/8
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',       // GCP metadata
  'instance-data',                   // AWS metadata alias
]);

export function isUrlSafe(url: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Scheme check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Scheme "${parsed.protocol}" is not allowed. Only http and https are permitted.` };
  }

  // Credentials in URL
  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'URLs with embedded credentials are not allowed.' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `Hostname "${hostname}" is blocked.` };
  }

  // IPv6 loopback
  if (hostname === '::1' || hostname === '[::1]') {
    return { safe: false, reason: 'IPv6 loopback address is blocked.' };
  }

  // IPv6 private ranges (fc00::/7, fe80::/10)
  if (/^(fc|fd|fe[89ab])/.test(hostname.replace(/[\[\]]/g, ''))) {
    return { safe: false, reason: 'Private IPv6 address is blocked.' };
  }

  // Private IPv4
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return { safe: false, reason: `Private IP address "${hostname}" is blocked.` };
    }
  }

  // AWS metadata endpoint
  if (hostname === '169.254.169.254') {
    return { safe: false, reason: 'Cloud metadata endpoint is blocked.' };
  }

  return { safe: true };
}
