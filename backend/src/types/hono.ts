export type AppVariables = {
  vexaUserId: number
  vexaToken: string
  vexaTokenScopes: string[]
  vexaApiTokenId: number
  userEmail: string
  userName: string | null
  maxConcurrentBots: number
}

export type AppEnv = { Variables: AppVariables }
