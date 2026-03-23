# stefanfriend.com

Personal site — Clarity in Complex Systems.

## Deployment (GitHub Pages)

1. Create a new repo on GitHub (e.g., `stefanfriend.com`)
2. Push this entire directory to `main` branch
3. Go to **Settings → Pages → Source** → select `main` branch, root `/`
4. In your domain registrar, add DNS records:
   - `A` records → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` record: `www` → `<your-github-username>.github.io`
5. GitHub will auto-provision HTTPS via Let's Encrypt

The `CNAME` file tells GitHub Pages to serve at `stefanfriend.com`.
The `.nojekyll` file tells GitHub to serve raw HTML without Jekyll processing.

## Structure

```
index.html                          — Homepage
writing/
  agentic-teams.html                — What Building with Agentic Teams Changes
  first-contact.html                — First Contact: A Real Workflow...
  mental-health-startups.html       — The Reality of Mental Health and Startups
  be-mighty.html                    — Be Mighty
  learning-to-lead.html             — Learning to Lead
CNAME                               — Custom domain config
.nojekyll                           — Bypass Jekyll processing
```

## Customization

- **Contact**: Currently links to LinkedIn. Swap to `mailto:stefan@stefanfriend.com` once Google Workspace is connected.
- **Sobriety count**: Update "3,796 days" in index.html and be-mighty.html as time passes (or build a JS counter).
- **Colors**: Edit CSS variables in `:root` on any page.
- **New essays**: Copy any essay template, update content, and add a link to the essay-list in index.html.
