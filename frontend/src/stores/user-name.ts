export function adminName(user: {
  id?: string
  adminLabel?: string | null
  username?: string | null
  loginEmail: string | null
}) {
  return (
    user.adminLabel ||
    user.username ||
    user.loginEmail?.split('@')[0] ||
    (user.id ? '档案 ' + user.id.slice(0, 8) : '未命名客户')
  )
}
