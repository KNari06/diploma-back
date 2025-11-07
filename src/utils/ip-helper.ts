import { Request } from 'express';

/**
 * Get client IP address from request
 * Priority: x-forwarded-for > x-real-ip > req.ip > connection
 * All sources are server-side (secure for rate limiting)
 */
export function getClientIp(req: Request): string {
  // Priority 1: x-forwarded-for header (set by proxy/load balancer)
  const forwardedFor = req.headers['x-forwarded-for'] as string;
  if (forwardedFor) {
    // x-forwarded-for can contain multiple IPs, take the first one (original client)
    const ips = forwardedFor.split(',').map(ip => ip.trim());
    const clientIp = ips[0];
    if (clientIp && clientIp !== 'unknown') {
      return clientIp;
    }
  }

  // Priority 2: x-real-ip header (set by some proxies like Nginx)
  const realIp = req.headers['x-real-ip'] as string;
  if (realIp && realIp !== 'unknown') {
    return realIp;
  }

  // Priority 3: req.ip (set by express when trust proxy is enabled)
  if (req.ip && req.ip !== '::1' && req.ip !== '127.0.0.1') {
    return req.ip;
  }

  // Priority 4: Connection remote address (direct connection)
  const remoteAddress = req.connection?.remoteAddress || req.socket?.remoteAddress;
  if (remoteAddress) {
    return remoteAddress.replace(/^::ffff:/, '');
  }

  return 'unknown';
}

/**
 * Normalize IP address for use as anonymous ID
 * Converts IPv6 to IPv4 if possible, handles localhost
 */
export function normalizeIpForAnonymousId(ip: string): string {
  // Remove IPv6 prefix
  let normalized = ip.replace(/^::ffff:/, '');

  // Handle localhost/loopback addresses
  if (normalized === '::1' || normalized === '127.0.0.1' || normalized === 'localhost') {
    return '127.0.0.1';
  }

  // Handle unknown
  if (normalized === 'unknown' || !normalized) {
    return 'unknown';
  }

  return normalized;
}
