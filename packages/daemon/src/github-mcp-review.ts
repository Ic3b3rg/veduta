import { createHash } from 'node:crypto'

// Schemas discovered from the pinned release; see ADR-0035 and the adjacent fixtures.
export const GITHUB_MCP_SCHEMAS = {
  read: {
    name: 'list_issues',
    hash: '56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119',
  },
  write: {
    name: 'issue_write',
    hash: '97fade9d761e39e29714162058cbcc5a484d65372be703889dd86f9d062c811b',
  },
  files: {
    name: 'get_file_contents',
    hash: '5d7f569392e212ac9b5b8a985d986c69f317f3052f265626498aa3d0a4ec2bb8',
  },
} as const
export type GithubMcpMode = keyof typeof GITHUB_MCP_SCHEMAS
export const GITHUB_READ_PROFILE_HASH = createHash('sha256')
  .update(JSON.stringify([GITHUB_MCP_SCHEMAS.read, GITHUB_MCP_SCHEMAS.files]))
  .digest('hex')
