// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import starlightLinksValidator from 'starlight-links-validator';

// GitHub Pages project-site base path.
const SITE = 'https://quarrysystems.github.io';
const BASE = '/pangolin';

export default defineConfig({
  site: SITE,
  base: BASE,
  redirects: {
    '/pangolin/reference/agora-client-api/': '/pangolin/reference/pangolin-client-api/',
    '/agora/reference/agora-client-api/': '/pangolin/reference/pangolin-client-api/',
    '/pangolin/explanation/decisions/0006-agora-mcp-auth-whoever-launched/': '/pangolin/explanation/decisions/0006-pangolin-mcp-auth-whoever-launched/',
  },
  integrations: [
    mermaid({ theme: 'default' }),
    starlight({
      title: 'Pangolin Scale',
      description:
        'Secure, deterministic, auditable execution of AI agents — dispatch a DAG of tasks, fan out under file-locks, get back reviewable patches and a tamper-evident audit trail.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/quarrysystems/pangolin' },
      ],
      editLink: { baseUrl: 'https://github.com/quarrysystems/pangolin/edit/main/docs-site/' },
      lastUpdated: true,
      plugins: [
        // Strict link validation is turned on in a later task once all pages exist.
        // Seeded here in lenient mode so the config is in place.
        starlightLinksValidator({ errorOnRelativeLinks: true, errorOnInvalidHashes: true }),
      ],
      sidebar: [
        {
          label: 'Tutorials',
          items: [
            { slug: 'tutorials/first-dispatch' },
            { slug: 'tutorials/first-offload-run' },
          ],
        },
        {
          label: 'How-to guides',
          items: [
            { slug: 'how-to/worker-file-layout' },
            { slug: 'how-to/sync-capabilities-subagents' },
            { slug: 'how-to/handle-needs-input' },
            { slug: 'how-to/remote-docker-dispatch' },
            { slug: 'how-to/deploy-fargate-s3' },
            { slug: 'how-to/verify-audit-bundle' },
            { slug: 'how-to/write-a-provider' },
          ],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
        { label: 'Commercial & pilots', slug: 'commercial' },
        {
          label: 'Explanation',
          items: [
            { slug: 'explanation/project-status-roadmap' },
            { slug: 'explanation/architecture-overview' },
            { slug: 'explanation/how-offload-runs' },
            { slug: 'explanation/typed-product-handoff' },
            { slug: 'explanation/execution-patterns' },
            { slug: 'explanation/sandboxing-ai-agents' },
            { slug: 'explanation/audit-guarantee-tiers' },
            { slug: 'explanation/privilege-boundary' },
            { slug: 'explanation/licensing-bsl' },
            { label: 'Decision records', items: [{ autogenerate: { directory: 'explanation/decisions' } }] },
          ],
        },
      ],
    }),
  ],
});
