# Deployment preparation

Nothing in this repository has been pushed, published or deployed. The last step of each section needs Jon's explicit approval.

## 1. Put the repository on GitHub

```bash
# from the unpacked flowcheck folder
gh repo create Jonn3/flowcheck --private --source=. --remote=origin
git push -u origin main
```

Start private. Make it public only after the checklist in section 4.

## 2. Open a reviewable pull request for future changes

```bash
git checkout -b your-change
# edit, then:
npm run verify
git commit -am "Describe the change"
git push -u origin your-change
gh pr create --fill
```

`.github/workflows/ci.yml` runs the tests and the build on every pull request.

## 3. Publish the demo with GitHub Pages

`.github/workflows/pages.yml` builds `dist/index.html` and deploys it. It runs only when started by hand, so nothing goes live by accident.

1. Repository Settings → Pages → Source: **GitHub Actions**.
2. Actions → "Deploy demo" → **Run workflow**. This is the approval step.
3. The demo appears at `https://jonn3.github.io/flowcheck/`.

GitHub Pages is free for public repositories. A private repository needs a paid plan for Pages, so make the repository public first or use another static host. The demo is one HTML file and works on any of them.

## 4. Checklist before making anything public

- [ ] `npm run verify` passes on your machine.
- [ ] `npm run test:browser` passes on your machine.
- [ ] You completed `docs/CONTRIBUTION.md` and the statement on the "Inside the project" page matches it.
- [ ] You can do the interview walkthrough without notes.
- [ ] You opened the page on your phone and completed the challenge.
- [ ] You searched the repository for anything private. Expected result: nothing about trading, real estate, grades, finances or your address.
- [ ] You chose a license, or decided to publish without one.
- [ ] The repository description and the LinkedIn text describe only what is implemented.

## 5. After publishing

- Pin the repository on your GitHub profile.
- Add the demo link to LinkedIn Featured.
- Add the resume bullet only once the demo link is live.
