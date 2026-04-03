export const ErrorCodes = {
  INVALID_TOKEN: { code: 'INVALID_TOKEN', status: 401, message: 'Token is invalid or expired' },
  TOKEN_VERSION_MISMATCH: { code: 'TOKEN_VERSION_MISMATCH', status: 401, message: 'Token version mismatch, re-enroll required' },
  SITE_ID_MISMATCH: { code: 'SITE_ID_MISMATCH', status: 403, message: 'Site ID in request body does not match token' },
  DEVICE_ID_MISMATCH: { code: 'DEVICE_ID_MISMATCH', status: 403, message: 'Device ID in request body does not match token' },
  DEVICE_DISABLED: { code: 'DEVICE_DISABLED', status: 403, message: 'Device has been disabled' },
  MAX_DEVICES_REACHED: { code: 'MAX_DEVICES_REACHED', status: 403, message: 'Maximum number of devices reached' },
  INVALID_PAYLOAD: { code: 'INVALID_PAYLOAD', status: 400, message: 'Request payload validation failed' },
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', status: 500, message: 'Internal server error' },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;
