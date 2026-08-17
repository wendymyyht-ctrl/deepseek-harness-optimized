import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-email-local'
export const inject = ['tools']

const ACCOUNT_FILE = process.env.DSH_EMAIL_ACCOUNTS_FILE?.trim()
const CREDENTIALS_DIR = process.env.DSH_EMAIL_CREDENTIALS_DIR?.trim()
const KEYCHAIN_SERVICE = process.env.DSH_EMAIL_KEYCHAIN_SERVICE?.trim()
  || 'DeepSeek Harness Optimized Email Authorization Code'
const MAX_MESSAGE_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024

const PROVIDERS = {
  qq: {
    name: 'QQ邮箱',
    domains: ['qq.com', 'foxmail.com', 'vip.qq.com'],
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
  },
  netease: {
    name: '网易邮箱',
    domains: ['163.com', '126.com', 'yeah.net'],
    imapHost(domain) { return `imap.${domain}` },
    smtpHost(domain) { return `smtp.${domain}` },
    imap: { port: 993, secure: true },
    smtp: { port: 465, secure: true },
  },
}

function runProcess(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { if (stdout.length < 200_000) stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { if (stderr.length < 200_000) stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`credential lookup failed with code ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}

async function keychainPassword(email, signal) {
  const value = await runProcess('/usr/bin/security', [
    'find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', email,
  ], signal)
  const authorizationCode = value.replace(/[\r\n]+$/, '')
  if (!authorizationCode) throw new Error(`no authorization code is stored for ${email}`)
  return authorizationCode
}

function credentialFilename(email) {
  return `${createHash('sha256').update(email.toLowerCase()).digest('hex')}.txt`
}

async function windowsPassword(email, signal) {
  if (!CREDENTIALS_DIR) throw new Error('the Windows email credential directory is not configured')
  const credentialFile = join(CREDENTIALS_DIR, credentialFilename(email))
  const command = [
    "$secure = Get-Content -Raw -LiteralPath $env:DSH_EMAIL_CREDENTIAL_FILE | ConvertTo-SecureString",
    '$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }',
  ].join('; ')
  const value = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        DSH_EMAIL_CREDENTIAL_FILE: credentialFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { if (stdout.length < 10_000) stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { if (stderr.length < 20_000) stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`unable to unlock the Windows email authorization code: ${stderr.trim() || `status ${code}`}`))
    })
  })
  const authorizationCode = value.replace(/[\r\n]+$/u, '')
  if (!authorizationCode) throw new Error(`no authorization code is stored for ${email}`)
  return authorizationCode
}

async function accountPassword(email, signal) {
  if (process.platform === 'darwin') return keychainPassword(email, signal)
  if (process.platform === 'win32') return windowsPassword(email, signal)
  throw new Error('email credentials are supported by the macOS and Windows desktop builds')
}

async function loadAccounts() {
  if (!ACCOUNT_FILE) throw new Error('the email account file is not configured')
  let parsed
  try {
    parsed = JSON.parse(await readFile(ACCOUNT_FILE, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`unable to read email account configuration: ${error}`)
  }
  if (!Array.isArray(parsed?.accounts)) throw new Error('invalid email account configuration')
  return parsed.accounts.filter(account =>
    account && typeof account.email === 'string' && typeof account.provider === 'string',
  )
}

async function resolveAccount(identifier) {
  const accounts = await loadAccounts()
  if (!accounts.length) {
    throw new Error('no email account is configured; use DeepSeek Harness > 邮箱账户设置… first')
  }
  const normalized = identifier.trim().toLowerCase()
  const exact = accounts.find(account => account.email.toLowerCase() === normalized)
  if (exact) return exact
  const providerMatches = accounts.filter(account => account.provider === normalized)
  if (providerMatches.length === 1) return providerMatches[0]
  throw new Error(`email account "${identifier}" is not configured; available accounts: ${accounts.map(a => a.email).join(', ')}`)
}

function accountServers(account) {
  const provider = PROVIDERS[account.provider]
  if (!provider) throw new Error(`unsupported email provider: ${account.provider}`)
  const domain = account.email.split('@').pop()?.toLowerCase() || ''
  if (!provider.domains.includes(domain)) throw new Error(`email domain ${domain} does not match provider ${account.provider}`)
  return {
    provider,
    imap: {
      host: provider.imapHost ? provider.imapHost(domain) : provider.imap.host,
      port: provider.imap.port,
      secure: provider.imap.secure,
    },
    smtp: {
      host: provider.smtpHost ? provider.smtpHost(domain) : provider.smtp.host,
      port: provider.smtp.port,
      secure: provider.smtp.secure,
    },
  }
}

async function withImap(account, signal, callback) {
  const authorizationCode = await accountPassword(account.email, signal)
  const { imap } = accountServers(account)
  const client = new ImapFlow({
    ...imap,
    auth: { user: account.email, pass: authorizationCode },
    clientInfo: {
      name: 'DeepSeek Harness',
      version: '1.0',
      vendor: 'Local DeepSeek Harness',
      'support-email': account.email,
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    maxLiteralSize: MAX_MESSAGE_SOURCE_BYTES,
    maxResponseSize: MAX_MESSAGE_SOURCE_BYTES + 1_000_000,
  })
  const abort = () => client.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await client.connect()
    return await callback(client)
  } finally {
    signal?.removeEventListener('abort', abort)
    if (client.usable) await client.logout().catch(() => client.close())
    else client.close()
  }
}

function addresses(value) {
  if (!Array.isArray(value)) return []
  return value.map(entry => ({ name: entry.name || '', address: entry.address || '' }))
}

function envelopeRecord(message) {
  const envelope = message.envelope || {}
  return {
    uid: message.uid,
    subject: envelope.subject || '',
    from: addresses(envelope.from),
    to: addresses(envelope.to),
    cc: addresses(envelope.cc),
    date: envelope.date instanceof Date ? envelope.date.toISOString() : envelope.date || message.internalDate || null,
    messageId: envelope.messageId || null,
    seen: message.flags instanceof Set ? message.flags.has('\\Seen') : false,
    flagged: message.flags instanceof Set ? message.flags.has('\\Flagged') : false,
  }
}

function parseRecipients(value) {
  const list = Array.isArray(value) ? value : []
  const cleaned = list.map(item => String(item).trim()).filter(Boolean)
  if (cleaned.some(item => item.length > 500 || item.includes('\0'))) throw new Error('invalid recipient address')
  return cleaned
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'email_accounts',
    description: 'List locally configured QQ Mail and NetEase Mail accounts. Authorization codes stay in the operating-system credential store and are never returned.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const accounts = await loadAccounts()
      return JSON.stringify(accounts.map(account => ({
        email: account.email,
        provider: account.provider,
        providerName: PROVIDERS[account.provider]?.name || account.provider,
      })), null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'email_test',
    description: 'Verify IMAP reading and SMTP sending connections for one configured email account without reading or sending any message.',
    parameters: {
      account: { type: 'string', required: true, description: 'Configured email address, or provider alias qq/netease when unique.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const account = await resolveAccount(args.account)
      const authorizationCode = await accountPassword(account.email, exec.signal)
      const { smtp } = accountServers(account)
      await withImap(account, exec.signal, async client => {
        await client.list({ statusQuery: { messages: true, unseen: true } })
      })
      const transporter = nodemailer.createTransport({
        ...smtp,
        auth: { user: account.email, pass: authorizationCode },
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        disableUrlAccess: true,
      })
      await transporter.verify()
      transporter.close()
      return JSON.stringify({ account: account.email, imap: 'ok', smtp: 'ok' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'email_list',
    description: 'Search or list email headers from a configured QQ or NetEase mailbox without downloading message bodies. Use unreadOnly for new mail and text/from/subject filters for searches.',
    parameters: {
      account: { type: 'string', required: true, description: 'Configured email address, or provider alias qq/netease when unique.' },
      folder: { type: 'string', description: 'IMAP folder, defaults to INBOX.' },
      unreadOnly: { type: 'boolean', description: 'Return only unread messages when true.' },
      from: { type: 'string', description: 'Sender substring filter.' },
      subject: { type: 'string', description: 'Subject substring filter.' },
      text: { type: 'string', description: 'Search message headers and body text.' },
      sinceDays: { type: 'number', description: 'Only messages from the last N days, from 1 to 3650.' },
      limit: { type: 'number', description: 'Maximum results, from 1 to 100. Defaults to 20.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const account = await resolveAccount(args.account)
      const folder = (args.folder || 'INBOX').trim()
      const limit = Number(args.limit ?? 20)
      if (!folder || folder.length > 500) throw new Error('invalid folder name')
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be from 1 to 100')
      const query = {}
      if (args.unreadOnly) query.seen = false
      if (args.from) query.from = args.from.slice(0, 1_000)
      if (args.subject) query.subject = args.subject.slice(0, 1_000)
      if (args.text) query.text = args.text.slice(0, 2_000)
      if (args.sinceDays !== undefined) {
        const days = Number(args.sinceDays)
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('sinceDays must be from 1 to 3650')
        query.since = new Date(Date.now() - days * 86_400_000)
      }
      if (!Object.keys(query).length) query.all = true
      return withImap(account, exec.signal, async client => {
        await client.mailboxOpen(folder, { readOnly: true })
        const uids = await client.search(query, { uid: true })
        const selected = Array.isArray(uids) ? uids.slice(-limit).reverse() : []
        if (!selected.length) return '[]'
        const rows = await client.fetchAll(selected, { envelope: true, flags: true, internalDate: true }, { uid: true })
        const byUid = new Map(rows.map(row => [row.uid, envelopeRecord(row)]))
        return JSON.stringify(selected.map(uid => byUid.get(uid)).filter(Boolean), null, 2)
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'email_read',
    description: 'Read one email body and attachment metadata by IMAP UID from a configured QQ or NetEase mailbox. This is read-only and does not download attachment contents.',
    parameters: {
      account: { type: 'string', required: true, description: 'Configured email address, or provider alias qq/netease when unique.' },
      uid: { type: 'number', required: true, description: 'Message UID returned by email_list.' },
      folder: { type: 'string', description: 'IMAP folder, defaults to INBOX.' },
      maxChars: { type: 'number', description: 'Maximum body characters, from 1000 to 200000. Defaults to 50000.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const account = await resolveAccount(args.account)
      const folder = (args.folder || 'INBOX').trim()
      const uid = Number(args.uid)
      const maxChars = Number(args.maxChars ?? 50_000)
      if (!Number.isInteger(uid) || uid < 1) throw new Error('uid must be a positive integer')
      if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > 200_000) throw new Error('maxChars must be from 1000 to 200000')
      return withImap(account, exec.signal, async client => {
        await client.mailboxOpen(folder, { readOnly: true })
        const message = await client.fetchOne(String(uid), { source: true, envelope: true, flags: true, internalDate: true }, { uid: true })
        if (!message || !message.source) throw new Error(`message UID ${uid} was not found in ${folder}`)
        const parsed = await simpleParser(message.source, { skipImageLinks: true })
        const textBody = typeof parsed.text === 'string'
          ? parsed.text
          : typeof parsed.html === 'string' ? parsed.html : ''
        const clipped = textBody.length > maxChars ? `${textBody.slice(0, maxChars)}\n\n[Email body truncated]` : textBody
        return JSON.stringify({
          ...envelopeRecord(message),
          body: clipped,
          attachments: (parsed.attachments || []).map(item => ({
            filename: item.filename || '',
            contentType: item.contentType || '',
            size: item.size || item.content?.length || 0,
            contentId: item.cid || null,
          })),
        }, null, 2)
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'email_send',
    description: 'Send an email through a configured QQ or NetEase SMTP account. Call only when the user clearly instructs sending now and has specified or approved the sender account, recipients, subject, body, and attachments. If any of those are ambiguous, prepare a draft in chat and ask first. Never infer a recipient address.',
    parameters: {
      account: { type: 'string', required: true, description: 'Configured sender email address, or provider alias qq/netease when unique.' },
      to: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact recipient email addresses.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC addresses.' },
      bcc: { type: 'array', items: { type: 'string' }, description: 'Optional BCC addresses.' },
      subject: { type: 'string', required: true, description: 'Approved email subject.' },
      text: { type: 'string', required: true, description: 'Approved plain-text body.' },
      html: { type: 'string', description: 'Optional approved HTML body.' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Optional absolute local file paths approved by the user.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const account = await resolveAccount(args.account)
      const to = parseRecipients(args.to)
      const cc = parseRecipients(args.cc)
      const bcc = parseRecipients(args.bcc)
      const subject = args.subject.trim()
      const text = args.text
      if (!to.length) throw new Error('at least one exact recipient is required')
      if (!subject || subject.length > 1_000) throw new Error('subject must contain 1 to 1000 characters')
      if (typeof text !== 'string' || !text.trim() || text.length > 1_000_000) throw new Error('email text must contain 1 to 1000000 characters')
      if (args.html !== undefined && (typeof args.html !== 'string' || args.html.length > 2_000_000)) throw new Error('HTML body is too large')
      const attachmentPaths = Array.isArray(args.attachments) ? args.attachments : []
      if (attachmentPaths.length > 10) throw new Error('at most 10 attachments are allowed')
      let totalBytes = 0
      const attachments = []
      for (const path of attachmentPaths) {
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error(`invalid attachment path: ${path}`)
        const info = await stat(path)
        if (!info.isFile()) throw new Error(`attachment is not a file: ${path}`)
        totalBytes += info.size
        if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('total attachment size exceeds 20 MiB')
        attachments.push({ path })
      }
      const authorizationCode = await accountPassword(account.email, exec.signal)
      const { smtp } = accountServers(account)
      const transporter = nodemailer.createTransport({
        ...smtp,
        auth: { user: account.email, pass: authorizationCode },
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 120_000,
        disableUrlAccess: true,
      })
      try {
        const result = await transporter.sendMail({
          from: account.email,
          to,
          cc: cc.length ? cc : undefined,
          bcc: bcc.length ? bcc : undefined,
          subject,
          text,
          html: args.html,
          attachments,
        })
        return JSON.stringify({
          sent: true,
          account: account.email,
          to,
          cc,
          bccCount: bcc.length,
          subject,
          messageId: result.messageId,
          accepted: result.accepted,
          rejected: result.rejected,
          response: result.response,
        }, null, 2)
      } finally {
        transporter.close()
      }
    },
  }))
}
