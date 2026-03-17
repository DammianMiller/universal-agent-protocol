---
name: sec-context-review
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`


## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:sec-context-review.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
# Security Anti-Pattern Review Skill

**Trigger**: Use when reviewing code for security vulnerabilities or before committing/PR.

## Overview

This skill applies the sec-context security anti-patterns (distilled from 150+ sources) to review AI-generated or human-written code for common security vulnerabilities.

## Quick Reference - Top 10 AI Code Anti-Patterns

| Rank | Anti-Pattern | CWE | Quick Fix |
|------|--------------|-----|-----------|
| 1 | **Dependency Risks (Slopsquatting)** | CWE-1357 | Verify packages exist before import |
| 2 | **XSS Vulnerabilities** | CWE-79 | Encode output for context |
| 3 | **Hardcoded Secrets** | CWE-798 | Use environment variables |
| 4 | **SQL Injection** | CWE-89 | Use parameterized queries |
| 5 | **Authentication Failures** | CWE-287 | Apply auth to all protected endpoints |
| 6 | **Missing Input Validation** | CWE-20 | Validate type, length, format, range |
| 7 | **Command Injection** | CWE-78 | Use argument arrays, avoid shell |
| 8 | **Missing Rate Limiting** | CWE-770 | Implement per-IP/user limits |
| 9 | **Excessive Data Exposure** | CWE-200 | Use DTOs with field allowlists |
| 10 | **Unrestricted File Upload** | CWE-434 | Validate extension, MIME, and size |

## Key Statistics (Why This Matters)

- AI-generated code has an **86% XSS failure rate** (vs 31.6% human code)
- **5-21% of AI-suggested packages don't exist** (slopsquatting risk)
- AI code is **2.74x more likely** to have XSS vulnerabilities
- **72% of Java AI code** contains vulnerabilities
- **81% of organizations** have shipped vulnerable AI-generated code to production

---

## Security Review Checklist

### 1. Secrets & Credentials (CWE-798)

**Check for:**
```
BAD PATTERNS:
- API_KEY = "sk_live_..."
- password = "..."
- AWS_ACCESS_KEY = "AKIA..."
- connectionString = "mongodb://user:pass@..."
- JWT_SECRET = "hardcoded"
```

**Fix:** Environment variables or secret manager
```
GOOD:
- api_key = environment.get("API_KEY")
- if (!api_key) throw Error("API_KEY required")
```

### 2. SQL Injection (CWE-89)

**Check for:**
```
BAD:
query = "SELECT * FROM users WHERE id = '" + user_id + "'"
db.query(`SELECT * FROM users WHERE email = '${email}'`)
```

**Fix:** Parameterized queries
```
GOOD:
query = "SELECT * FROM users WHERE id = ?"
db.execute(query, [user_id])
```

### 3. XSS - Cross-Site Scripting (CWE-79)

**Check for:**
```
BAD:
html = "<div>" + userInput + "</div>"
element.innerHTML = userContent
document.write(userData)
```

**Fix:** HTML encoding or safe DOM methods
```
GOOD:
html = "<div>" + htmlEncode(userInput) + "</div>"
element.textContent = userContent
DOMPurify.sanitize(userContent)
```

### 4. Command Injection (CWE-78)

**Check for:**
```
BAD:
exec("ping " + hostname)
shell.run("convert " + inputPath)
os.system("git clone " + url)
```

**Fix:** Argument arrays, no shell
```
GOOD:
execFile("ping", ["-c", "4", hostname])
spawn("convert", [inputPath, outputPath])
```

### 5. Path Traversal (CWE-22)

**Check for:**
```
BAD:
file = path.join(uploadDir, filename)
fs.readFile(userPath)
```

**Fix:** Validate paths
```
GOOD:
filename = path.basename(userInput)
realPath = path.resolve(uploadDir, filename)
if (!realPath.startsWith(uploadDir)) throw Error()
```

### 6. Missing Input Validation (CWE-20)

**Check for:**
- User input passed directly to database/system
- No type checking on API parameters
- No length limits on string inputs
- No format validation (email, UUID, etc.)

**Fix:** Validate everything
```
GOOD:
schema = z.object({
  email: z.string().email().max(255),
  age: z.number().int().min(0).max(150),
  id: z.string().uuid()
})
validated = schema.parse(input)
```

### 7. Weak Cryptography (CWE-327)

**Check for:**
```
BAD:
md5(password)
sha1(secret)
DES.encrypt(data)
Math.random() for tokens
```

**Fix:** Modern algorithms
```
GOOD:
bcrypt.hash(password, 12)
argon2.hash(password)
AES-256-GCM
crypto.randomBytes(32)
```

### 8. Authentication Failures (CWE-287)

**Check for:**
- Endpoints without authentication
- Session tokens from Math.random()
- Passwords stored in plaintext
- No rate limiting on login
- Session fixation (no regeneration)

**Fix:**
```
GOOD:
- Auth middleware on all protected routes
- crypto.randomBytes() for tokens
- bcrypt/argon2 for passwords
- Rate limiting: 5 attempts per minute
- Regenerate session on login
```

### 9. Insecure Dependencies (CWE-1357)

**Check for:**
- Packages that don't exist (hallucinated by AI)
- Typosquatting (lodash vs 1odash)
- Outdated packages with CVEs
- Unpinned versions

**Fix:**
```bash
# Verify package exists
npm view <package-name>

# Check for vulnerabilities
npm audit

# Pin versions
"lodash": "4.17.21"  # Not "^4.17.21"
```

### 10. Missing Security Headers (CWE-16)

**Required headers:**
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'self'
X-XSS-Protection: 1; mode=block
```

---

## Review Output Format

When reviewing code, output findings in this format:

```markdown
## Security Review Results

### 🔴 CRITICAL (Block immediately)
1. **[CWE-798] Hardcoded Secret** - `src/config.ts:23`
   - Found: `API_KEY = "sk_live_abc123"`
   - Fix: `const API_KEY = process.env.API_KEY`
   - Action: Rotate this key immediately if committed

### 🟠 HIGH (Fix before merge)
1. **[CWE-89] SQL Injection** - `src/db/users.ts:45`
   - Found: String concatenation in query
   - Fix: Use parameterized query

### 🟡 MEDIUM (Fix soon)
1. **[CWE-16] Missing Security Headers**
   - Fix: Add helmet middleware

### 🟢 LOW (Best practice)
1. **[CWE-330] Weak Random** - Using Math.random()
   - Fix: Use crypto.randomBytes()

### Summary
- Critical: 1
- High: 1
- Medium: 1
- Low: 1
- **Security Score: 4/10**
```

---

## Pre-Generation Checklist

Before generating ANY code, verify:

- [ ] No hardcoded credentials, API keys, or secrets
- [ ] Database queries use parameterized statements
- [ ] User input is validated (type, length, format)
- [ ] Shell commands use argument arrays, not strings
- [ ] HTML output is encoded to prevent XSS
- [ ] File paths are validated and canonicalized
- [ ] Cryptographic operations use modern algorithms
- [ ] Session tokens use cryptographic randomness
- [ ] All endpoints have appropriate authentication
- [ ] Dependencies exist and are verified

---

## Source

Based on [sec-context](https://github.com/Arcanum-Sec/sec-context) - AI Code Security Anti-Patterns distilled from 150+ sources.

Full patterns available at:
- `ANTI_PATTERNS_BREADTH.md` (~65K tokens) - 25+ patterns
- `ANTI_PATTERNS_DEPTH.md` (~100K tokens) - Deep dive on 7 critical patterns



## UAP Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```
