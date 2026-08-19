export type AppVariables = {
  userId: number
  userEmail: string
  userName: string | null
  maxConcurrentBots: number
}

export type AppEnv = { Variables: AppVariables }
