/**
 * Seed notes for the in-memory platform.
 *
 * Chosen to exercise the parts of the UI that are easy to get wrong with tidy
 * fixtures: nested directories, a long note that has to scroll, a note with a
 * table and fenced code, and names that sort ambiguously.
 *
 * The annotations and links are picked the same way. Between them they cover
 * all three checkbox states -- ticked, open, and a bare keyword that was never
 * asked -- a reminder with a due date and one without, a task in a note that is
 * not a journal so it has no day at all, and a `[[link]]` to a note that does
 * not exist, which is the state the editor has to draw differently.
 */
export const SEED_NOTES: Record<string, string> = {
  'inbox.md': `# Inbox

- [ ] renew the domain
- [ ] look at the *pull request* from Wednesday
- [x] pay the invoice

TODO decide where [[projects/garden/watering]] should actually live

Anything without a home lands here first. Empty this on Fridays.
`,

  'journal/2026-07-30.md': `# Thursday, 30 July

Slept badly. Spent the morning on the git topology and it finally clicked: the
bare hub is not an optimisation, it is the only arrangement where two writers
do not corrupt each other.

> A tool you have to be careful with is a tool you will eventually be careless
> with.

- [ ] TODO write the conflict dialog copy
- [x] TODO draw the git topology in [[architecture]]
- Reminder: renew the TLS certificate 2026-08-30

Tomorrow: the conflict dialog.
`,

  'journal/2026-08-01.md': `# Saturday, 1 August

Wrote the editor. Notes on what surprised me:

1. \`visualViewport\` is the only honest source of the keyboard height
2. autocorrect on a markdown buffer is genuinely unusable
3. vim in a compartment costs about twenty lines

TODO measure the bundle again once vim is code-split
Reminder: the domain expires 2026-07-31

See also [[reference/markdown]] and [[the graph view]], which is not written yet.
`,

  'projects/vim-notes/architecture.md': `# Architecture

Ports and adapters, deliberately thin. Five ports, one composition root, no
container.

| Port | Adapter | Notes |
|---|---|---|
| NoteStore | filesystem | re-checks containment itself |
| VersionControl | git | commit on save, push to the hub |
| Search | ripgrep | subprocess, streamed |
| TerminalHost | node-pty | the risky one |
| FileWatcher | chokidar | tags origin so the client can ignore echoes |

## The rule that matters

Every read returns a hash. Every write submits the hash it was based on.

\`\`\`ts
const outcome = await platform.write(path, content, expected)
if (!outcome.ok) {
  // refused, not applied -- ask the user
}
\`\`\`

Without this, editing on a phone at 17:00 silently destroys whatever nvim wrote
at 09:00.
`,

  'projects/vim-notes/todo.md': `# Todo

Tracked properly in [[journal/2026-08-01]].

## Now
- [ ] TODO conflict dialog: keep mine / take theirs / view both
- [ ] tree keyboard navigation
- [ ] search panel

## Later
- [ ] service worker, once offline editing is actually decided
- [ ] GitHub mirror of the hub
- [ ] Tauri build

## Rejected
- ~~a database with markdown in a column~~
- ~~Electron~~
`,

  'projects/garden/watering.md': `# Watering

Basil: every day, it is dramatic about it.
Rosemary: weekly, and it prefers to be forgotten.
Tomatoes: mornings only. Never the leaves.
`,

  'reference/shell.md': `# Shell

\`\`\`bash
# every branch merged into main, oldest first
git branch --merged main --format='%(committerdate:short) %(refname:short)' | sort

# what is actually taking up the disk
du -sh -- * | sort -h | tail -20
\`\`\`

See also [the git book](https://git-scm.com/book) when rebasing goes wrong.
`,

  'reference/markdown.md': `# Markdown

**bold**, *italic*, ~~struck through~~, \`inline code\`.

---

> Blockquotes nest, but nobody should.

1. ordered
2. lists
   - and nested unordered ones

[Links](https://example.com) render with the URL dimmed so the line stays
readable.
`,
}

/**
 * A few days of feed, for developing the news pane against.
 *
 * Chosen to cover the states the pane has to render rather than to be
 * representative: one top pick with a reason, one unscored item from a fetch
 * that ran before the LLM pass, one already read, one saved, and one with no
 * summary. A seed where everything is a well-formed 90 is a seed that hides
 * every layout problem worth finding.
 */
export const SEED_NEWS_LAST_RUN = 1_785_700_000

export const SEED_NEWS = [
  {
    id: 'seed-kev',
    url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
    title: 'CISA adds three actively exploited flaws to the KEV catalogue',
    source: 'CISA KEV',
    sourceKey: 'kev',
    category: 'security',
    author: null,
    published: 1_785_690_000,
    firstSeen: 1_785_695_000,
    signal: 0,
    signalLabel: '',
    summary:
      'Two are in edge devices already reachable from the internet, and one has a public proof of concept.',
    score: 94,
    isTop: true,
    topReason: 'actively exploited, and one is in something you run',
    read: false,
    saved: false,
  },
  {
    id: 'seed-repo',
    url: 'https://github.com/example/inference-engine',
    title: 'inference-engine: run quantised models on a laptop GPU',
    source: 'GitHub Trending',
    sourceKey: 'gh-trending',
    category: 'ai',
    author: 'example',
    published: 1_785_640_000,
    firstSeen: 1_785_660_000,
    signal: 2_400,
    signalLabel: '2.4k stars',
    summary: 'Claims a 3x speedup over llama.cpp on Apple silicon, with numbers.',
    score: 81,
    isTop: false,
    topReason: null,
    read: false,
    saved: true,
  },
  {
    id: 'seed-hn',
    url: 'https://news.ycombinator.com/item?id=1',
    title: 'A new approach to incremental parsing',
    source: 'Hacker News',
    sourceKey: 'hn',
    category: 'tech',
    author: null,
    published: 1_785_600_000,
    firstSeen: 1_785_610_000,
    signal: 842,
    signalLabel: '842 pts',
    summary: null,
    // Fetched, not yet scored: what the pane shows between a refresh and the
    // LLM pass, and the state most likely to be rendered as a zero by mistake.
    score: null,
    isTop: false,
    topReason: null,
    read: false,
    saved: false,
  },
  {
    id: 'seed-read',
    url: 'https://lobste.rs/s/1',
    title: 'Why your database is slower than it looks',
    source: 'Lobsters',
    sourceKey: 'lobsters',
    category: 'tech',
    author: 'someone',
    published: 1_785_500_000,
    firstSeen: 1_785_520_000,
    signal: 61,
    signalLabel: '61 pts',
    summary: 'Mostly about page cache behaviour under mixed read and write load.',
    score: 55,
    isTop: false,
    topReason: null,
    read: true,
    saved: false,
  },
]
