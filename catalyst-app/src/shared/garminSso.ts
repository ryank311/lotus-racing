// Garmin's hosted widget supports the Catalyst service-ticket grant. The newer
// Garmin Connect portal uses a different client configuration.
export function buildGarminLoginUrl(serviceUrl: string, clientId: string): string {
  const params = new URLSearchParams({
    id: 'gauth-widget', embedWidget: 'true',
    gauthHost: 'https://sso.garmin.com/sso',
    service: serviceUrl, source: serviceUrl,
    redirectAfterAccountLoginUrl: serviceUrl,
    redirectAfterAccountCreationUrl: serviceUrl,
    locale: 'en_US', mobile: 'true', clientId,
  })
  return `https://sso.garmin.com/sso/signin?${params}`
}

export function garminTicketFromUrl(candidate: string, serviceUrl: string): string | null {
  try {
    const url = new URL(candidate)
    const service = new URL(serviceUrl)
    if (url.origin !== service.origin || url.pathname !== service.pathname) return null
    const ticket = url.searchParams.get('ticket')
    return ticket && /^ST-[^\s]{1,4096}$/.test(ticket) ? ticket : null
  } catch { return null }
}
