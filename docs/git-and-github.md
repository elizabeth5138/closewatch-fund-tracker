# Git and GitHub, without the jargon

Your project lives in this folder:

```text
/Users/elizabethyong/.codex/.chatgpt-projects/g-p-6a6ab7fa45648191960f02e99af2b422/fund-tracker
```

Think of the folder as the desk where the work happens.

- **Git** is the time machine attached to that desk. It notices changed files
  and lets you save named checkpoints.
- A **repository** (usually shortened to **repo**) is the project folder plus
  that checkpoint history.
- **GitHub** is an online home for a Git repo. It adds backup, sharing, issue
  tracking, and code review; it is not the same thing as Git.
- A **commit** is one deliberate checkpoint. A useful commit says what changed
  and why, such as `Build reliable previous-close ingestion`.
- A **branch** is a safe side path through history. You can experiment without
  moving the main path until the change is ready.
- A **pull request** is a review conversation proposing that one branch be
  merged into another. You do not need one for every private experiment, but it
  becomes valuable when another person reviews the work.
- A **remote** is Git's nickname for another copy of the repo, usually the one
  on GitHub. The conventional nickname is `origin`.
- **Push** sends local commits to a remote. **Pull** brings remote commits down.

## The everyday loop

From inside the project folder:

```bash
git status
git diff
git add README.md app lib tests
git commit -m "Explain the change clearly"
git push
```

Read that as:

1. What changed?
2. Show me the exact edits.
3. Choose the edits for this checkpoint.
4. Save the checkpoint with a useful label.
5. Back it up online.

`git add` does not upload anything and does not permanently save anything. It
only places chosen changes in a staging area—the packing table for the next
commit.

## The safety rules that matter here

- Never commit `.env` files, API keys, bearer tokens, or brokerage credentials.
  This repo's `.gitignore` excludes local environment files while allowing the
  blank `.env.example` guide.
- Look at `git diff --staged` before committing. That is the exact package Git
  will save.
- Prefer small, coherent commits. “Add ingestion lease and its tests” is easier
  to review and undo than “Lots of changes.”
- A green test suite is evidence about a commit, not a substitute for reading
  the diff.
- Avoid force-pushing or rewriting shared history until you understand who else
  depends on it.

## What Git does not do

Git does not run the tracker every morning, host the website, retrieve market
prices, or protect a leaked secret. GitHub Actions runs the refresh; GitHub
Pages hosts the static dashboard. Git records the source that defines those
pieces.

## A useful picture

```text
working files → staged change → local commit → GitHub remote → deployed version
     edit          choose          save            back up          run
```

Each arrow is a separate action. That separation is a feature: it gives you a
chance to inspect what you are about to save, share, and deploy.
