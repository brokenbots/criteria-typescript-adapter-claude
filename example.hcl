# Example workflow using the Anthropic Claude adapter
#
# Prerequisites:
#   1. Build the adapter: bun run build
#   2. Install to plugins directory: cp out/adapter ~/.criteria/plugins/criteria-adapter-claude
#   3. Set ANTHROPIC_API_KEY via the host secret provider (e.g. export ANTHROPIC_API_KEY=...)
#
# Run: criteria apply example.hcl

workflow "code-review" {
  version       = "1.0"
  initial_state = "analyze"
  target_state  = "done"
}

adapter "claude" "default" {
  config {
    model         = "claude-sonnet-4-6"
    max_turns     = 10
    max_tokens    = 4096
    system_prompt = "You are a senior software engineer performing code reviews."
  }
}

step "analyze" {
  target = adapter.claude.default

  input {
    prompt = "Review this code for security vulnerabilities: $(file src/main.ts)"
    max_turns = 5
  }

  outcome "clean" {
    next = state.deploy
  }

  outcome "issues_found" {
    next = state.fix
  }

  outcome "failure" {
    next = state.failed
  }
}

step "fix" {
  target = adapter.claude.default

  input {
    prompt = "Fix the security issues found in the previous step."
  }

  outcome "success" {
    next = state.done
  }

  outcome "failure" {
    next = state.failed
  }
}

state "deploy" {
  terminal = true
}

state "done" {
  terminal = true
}

state "failed" {
  terminal = true
  success  = false
}
