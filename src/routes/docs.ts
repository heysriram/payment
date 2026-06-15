import { Router, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import swaggerUi from 'swagger-ui-express';

export const docsRouter = Router();

// Resolve openapi.yaml relative to the project root, regardless of cwd.
// __dirname under ts-node-dev = project/src/routes; under tsc build = project/dist/routes
const candidatePaths = [
  path.resolve(__dirname, '../../openapi.yaml'),
  path.resolve(process.cwd(), 'openapi.yaml'),
];
const specPath = candidatePaths.find((p) => fs.existsSync(p));

if (!specPath) {
  // Fail loud: deploys without the spec should not silently serve broken docs
  throw new Error(
    `openapi.yaml not found. Searched: ${candidatePaths.join(', ')}`
  );
}

const specYaml = fs.readFileSync(specPath, 'utf8');
const specJson = yaml.load(specYaml) as Record<string, unknown>;

// Raw spec endpoints — useful for SDK generators and CI lint
docsRouter.get('/openapi.yaml', (_req: Request, res: Response) => {
  res.type('text/yaml').send(specYaml);
});

docsRouter.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(specJson);
});

// Interactive docs at /api/payments/docs
docsRouter.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(specJson, {
    customSiteTitle: 'Payment Gateway API Reference',
    customCss: '.topbar { display: none }',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      tryItOutEnabled: true,
    },
  })
);
