// LOCKS-2 - Admin-side lock action constants.
// Master Manual §6 automation locks: Builder Hold/Suspend/Remove + Project Hold/Archive.

export const BUILDER_LOCK_ACTIONS = {
  HOLD: 'BUILDER_HOLD',
  SUSPEND: 'BUILDER_SUSPEND',
  REMOVE: 'BUILDER_REMOVE',
  REACTIVATE: 'BUILDER_REACTIVATE',
} as const

export const PROJECT_LOCK_ACTIONS = {
  HOLD: 'PROJECT_HOLD',
  ARCHIVE: 'PROJECT_ARCHIVE',
  REACTIVATE: 'PROJECT_REACTIVATE',
} as const

export const RESERVED_LOCK_ACTIONS = {
  BUILDER_AGREEMENT_SIGNED: 'BUILDER_AGREEMENT_SIGNED',
  COMMISSION_WRITTEN_OFF: 'COMMISSION_WRITTEN_OFF',
} as const

export const ALL_LOCK_ACTIONS = [
  ...Object.values(BUILDER_LOCK_ACTIONS),
  ...Object.values(PROJECT_LOCK_ACTIONS),
  ...Object.values(RESERVED_LOCK_ACTIONS),
] as const

export type BuilderLockAction = typeof BUILDER_LOCK_ACTIONS[keyof typeof BUILDER_LOCK_ACTIONS]
export type ProjectLockAction = typeof PROJECT_LOCK_ACTIONS[keyof typeof PROJECT_LOCK_ACTIONS]
export type LockAction = BuilderLockAction | ProjectLockAction

export const LOCK_ENTITIES = {
  BUILDER: 'builder',
  PROJECT: 'project',
} as const
export type LockEntity = typeof LOCK_ENTITIES[keyof typeof LOCK_ENTITIES]

export type BuilderStatusValue = 'ACTIVE' | 'ON_HOLD' | 'SUSPENDED' | 'REMOVED'
export type ProjectStatusValue = 'ACTIVE' | 'ON_HOLD' | 'ARCHIVED'

export function nextBuilderStatus(action: BuilderLockAction): BuilderStatusValue {
  switch (action) {
    case BUILDER_LOCK_ACTIONS.HOLD: return 'ON_HOLD'
    case BUILDER_LOCK_ACTIONS.SUSPEND: return 'SUSPENDED'
    case BUILDER_LOCK_ACTIONS.REMOVE: return 'REMOVED'
    case BUILDER_LOCK_ACTIONS.REACTIVATE: return 'ACTIVE'
  }
}

export function nextProjectStatus(action: ProjectLockAction): ProjectStatusValue {
  switch (action) {
    case PROJECT_LOCK_ACTIONS.HOLD: return 'ON_HOLD'
    case PROJECT_LOCK_ACTIONS.ARCHIVE: return 'ARCHIVED'
    case PROJECT_LOCK_ACTIONS.REACTIVATE: return 'ACTIVE'
  }
}

export function validateBuilderTransition(
  from: BuilderStatusValue,
  action: BuilderLockAction
): string | null {
  const to = nextBuilderStatus(action)
  if (from === to) return `Builder is already ${to}.`
  if (action === BUILDER_LOCK_ACTIONS.REACTIVATE && from === 'ACTIVE') {
    return 'Builder is already ACTIVE.'
  }
  if (from === 'REMOVED' && action !== BUILDER_LOCK_ACTIONS.REACTIVATE) {
    return 'Builder is REMOVED - Reactivate first before applying another action.'
  }
  return null
}

export function validateProjectTransition(
  from: ProjectStatusValue,
  action: ProjectLockAction
): string | null {
  const to = nextProjectStatus(action)
  if (from === to) return `Project is already ${to}.`
  if (action === PROJECT_LOCK_ACTIONS.REACTIVATE && from === 'ACTIVE') {
    return 'Project is already ACTIVE.'
  }
  if (from === 'ARCHIVED' && action !== PROJECT_LOCK_ACTIONS.REACTIVATE) {
    return 'Project is ARCHIVED - Reactivate first before applying another action.'
  }
  return null
}

export function reasonRequired(action: BuilderLockAction | ProjectLockAction): boolean {
  return (
    action !== BUILDER_LOCK_ACTIONS.REACTIVATE &&
    action !== PROJECT_LOCK_ACTIONS.REACTIVATE
  )
}