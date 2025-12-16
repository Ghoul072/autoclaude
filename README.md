# AutoClaude

Automated GitHub issue resolver powered by Claude. When an issue is opened, Claude analyzes it and either creates a PR with a fix or comments with its findings.

## How It Works

1. A GitHub issue is opened in your repository, OR a configured user is @mentioned in a comment
2. GitHub workflow triggers and sends the event to AutoClaude webhook
3. Claude analyzes the issue to determine if it can be resolved automatically
4. If yes: Claude creates a fix, commits it to a new branch, and opens a PR
5. If no: Claude comments on the issue explaining why it needs human attention

## Prerequisites

- Node.js 18+
- Claude CLI installed and authenticated (`claude` command available)
- GitHub Personal Access Token with `repo` permissions
- A server/machine where this service can run continuously

## Setup

### 1. Install and Configure AutoClaude Server

```bash
# Clone this repository
git clone git@github.com:Ghoul072/autoclaude.git
cd autoclaude

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
```

### 2. Configure Environment Variables

Edit `.env`:

```bash
# Port for the webhook server
PORT=3000

# Secret for webhook signature verification
# Generate with: openssl rand -hex 32
WEBHOOK_SECRET=<your-secret>

# GitHub token with repo permissions
GITHUB_TOKEN=ghp_<your-token>

# Path to local clone of target repo
REPO_PATH=/path/to/target-repo

# GitHub username to watch for @mentions in comments (optional)
GITHUB_MENTION_USER=your_github_username
```

### 3. Clone Target Repository

```bash
# Clone the repo you want AutoClaude to work on
git clone git@github.com:your-org/your-repo.git /path/to/target-repo
cd /path/to/target-repo

# Ensure you're on main branch
git checkout main
```

### 4. Add Workflow to Target Repository

Copy `.github/workflows/autoclaude-issue.yml` to your target repository:

```bash
cp .github/workflows/autoclaude-issue.yml /path/to/target-repo/.github/workflows/
```

Then add repository secrets in GitHub (Settings > Secrets and variables > Actions):

- `AUTOCLAUDE_WEBHOOK_URL`: URL where AutoClaude is running (e.g., `https://your-server.com`)
- `AUTOCLAUDE_WEBHOOK_SECRET`: Same secret as `WEBHOOK_SECRET` in your `.env`

### 5. Start the Server

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port | No (default: 3000) |
| `WEBHOOK_SECRET` | Secret for GitHub webhook signature verification | Recommended |
| `GITHUB_TOKEN` | GitHub PAT with repo permissions | Yes |
| `REPO_PATH` | Path to local clone of target repo | No (default: current directory) |
| `GITHUB_MENTION_USER` | GitHub username to trigger on @mentions in comments | No |

## Endpoints

- `GET /health` - Health check
- `POST /webhook/github` - GitHub webhook receiver

## What Issues Can Claude Resolve?

Claude will attempt to automatically resolve:
- Clear bugs with obvious fixes
- Simple feature additions with clear requirements
- Documentation updates
- Refactoring tasks with clear scope
- Dependency updates

Claude will NOT attempt to resolve (and will comment instead):
- Vague issues lacking detail
- Major architectural decisions
- Issues requiring external credentials/systems
- Security-sensitive changes
- Issues needing author clarification

## Security

- Webhook signatures are verified using HMAC SHA-256
- Use a strong, random webhook secret
- Store secrets securely (never commit `.env`)
- The GitHub token should have minimal required permissions

## Architecture

```
┌─────────────┐    Issue    ┌─────────────────┐
│   GitHub    │ ──────────► │  GitHub Action  │
│   Issue     │             │    Workflow     │
└─────────────┘             └────────┬────────┘
                                     │
                              Webhook POST
                                     │
                                     ▼
                            ┌─────────────────┐
                            │   AutoClaude    │
                            │     Server      │
                            └────────┬────────┘
                                     │
                              Claude CLI
                                     │
                                     ▼
                            ┌─────────────────┐
                            │  Analyze Issue  │
                            └────────┬────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
           ┌───────────────┐                ┌───────────────┐
           │  Can Resolve  │                │ Cannot Resolve│
           └───────┬───────┘                └───────┬───────┘
                   │                                │
                   ▼                                ▼
           ┌───────────────┐                ┌───────────────┐
           │   Create PR   │                │ Comment with  │
           │   with Fix    │                │   Findings    │
           └───────────────┘                └───────────────┘
```

## License

MIT
