import type { Handler, HostingEnv } from './env';
import { checkMethods } from './check-details';
import { commentMethods } from './comment-details';
import { fileMethods } from './detail-files';

export function detailMethods(env: HostingEnv): Record<string, Handler> {
  return {
    ...checkMethods(env),
    ...commentMethods(env),
    ...fileMethods(env),
  };
}
