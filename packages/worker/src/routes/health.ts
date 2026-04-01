import { SERVICE_NAME } from '@aiusage/shared';
import { jsonOk } from '../utils/response.js';
import type { Env } from '../types.js';

export function handleHealth(env: Env): Response {
  return jsonOk({
    siteId: env.SITE_ID,
    service: SERVICE_NAME,
    version: '0.1.0',
    time: new Date().toISOString(),
  });
}
