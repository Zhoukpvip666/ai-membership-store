export function adminName(user: {
  adminLabel?: string | null
  username?: string | null
  loginEmail: string
}) {
  return user.adminLabel || user.username || user.loginEmail.split('@')[0]!
}
