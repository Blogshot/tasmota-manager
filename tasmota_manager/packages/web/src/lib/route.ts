import { useEffect, useState } from 'react';

export const ROUTES = ['devices', 'pending', 'settings'] as const;
export type Route = (typeof ROUTES)[number];

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : 'devices';
}

/** Hash-Routing, damit Links unter dem Ingress-Pfad funktionieren. */
export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [route, (next) => (window.location.hash = `/${next}`)];
}
