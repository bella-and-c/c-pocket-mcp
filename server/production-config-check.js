const errors = []

requireSecret('C_POCKET_BRIDGE_TOKEN', 32)
requireSecret('C_POCKET_DROP_SECRET', 48)

const mcpPath = cleanEnvironmentValue(process.env.C_POCKET_MCP_PATH)
if (!/^\/mcp\/[A-Za-z0-9_-]{32,}$/.test(mcpPath)) {
  errors.push('C_POCKET_MCP_PATH must be /mcp/<32+ random characters>.')
}

if (process.env.HOST !== '0.0.0.0') {
  errors.push('HOST must be 0.0.0.0 inside the private production container network.')
}

if (errors.length) {
  console.error(`Production configuration rejected:\n- ${errors.join('\n- ')}`)
  process.exit(1)
}

console.log('Production configuration passed the secret and network checks.')

function requireSecret(name, minimumLength) {
  const value = cleanEnvironmentValue(process.env[name])
  if (value.length < minimumLength || /replace|example|password|secret/i.test(value)) {
    errors.push(`${name} must contain at least ${minimumLength} non-placeholder characters.`)
  }
}

function cleanEnvironmentValue(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim()
}
