import http from 'node:http';

export function json(res: http.ServerResponse, data: any, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

export function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

export async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export type Route = {
  method: string;
  pattern: RegExp;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void>;
};

export function route(method: string, path: string, handler: Route['handler']): Route {
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'
  );
  return { method, pattern, handler };
}
