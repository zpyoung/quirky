import type { Handler, HostingEnv } from './env';
import { checkMethods } from './check-details';
import { commentMethods } from './comment-details';
import { fileMethods } from './detail-files';
import { routeByProvider } from './gitlab/router';

export function detailMethods(env: HostingEnv): Record<string, Handler> {
  return routeByProvider(env, {
    ...checkMethods(env),
    ...commentMethods(env),
    ...fileMethods(env),
  });
}
