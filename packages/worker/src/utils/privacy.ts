import type { Env } from '../types.js';

export async function toPublicProjectName(project: string, env: Env): Promise<string> {
  const visibility = String(env.PUBLIC_PROJECT_VISIBILITY) as 'hidden' | 'masked' | 'plain';

  if (visibility === 'hidden') {
    return 'Hidden';
  }

  if (visibility === 'plain') {
    return project;
  }

  return maskProject(project, env.PROJECT_NAME_SALT);
}

async function maskProject(project: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(project));
  const hex = [...new Uint8Array(signature)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 6)
    .toUpperCase();

  return `Project ${hex}`;
}
