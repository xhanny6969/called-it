# CalledIt glasses app

The Even Hub web app for CalledIt. It is a thin client: it long-polls the CalledIt server for the
card to show and sends taps, swipes and push-to-talk audio back. See the repository README.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run simulate   # Even Hub simulator on the dev server
npx vite build && npx evenhub pack app.json dist -o calledit.ehpk
```

The server address defaults to `http://127.0.0.1:8787`; override it with `?api=http://host:port` or
`VITE_API_URL`, and add it to the `network` whitelist in `app.json`.
