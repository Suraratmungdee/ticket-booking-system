import type { RequestHandler } from 'express'

// Read at call time, not at module load: the tests re-import this module
// with a different NODE_ENV, and a value captured at import would be stale.
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// Set on every response, mounted ahead of every route.
//
// LIMITATION: no Content-Security-Policy. This service returns JSON and
// never HTML, so a CSP would constrain nothing. The day it serves any HTML
// — an error page, a docs route — CSP has to be added here, and the absence
// of one becomes a real hole rather than a no-op.
export const securityHeaders: RequestHandler = (_req, res, next) => {
  // Stop a browser from second-guessing our Content-Type and executing a
  // JSON body as script.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Nothing here should ever be framed.
  res.setHeader('X-Frame-Options', 'DENY')
  // Our URLs carry booking and ticket ids. Do not hand them to whatever
  // site a user clicks through to.
  res.setHeader('Referrer-Policy', 'no-referrer')

  // Production only, deliberately. Sent from a dev server, HSTS pins
  // localhost to HTTPS in the developer's browser for a year — across every
  // port and every other project on that machine — and clearing it is
  // awkward. The header is meaningless over plain HTTP anyway.
  if (isProduction()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  next()
}
