interface ProtoButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline-danger'
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'icon'
  loading?: boolean
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit' | 'reset'
  className?: string
  children: React.ReactNode
  'data-od-id'?: string
}

const VARIANT_CLASS: Record<string, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  'outline-danger': 'btn-outline-danger',
}

const SIZE_CLASS: Record<string, string> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
  icon: 'btn-icon',
}

export function ProtoButton({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  onClick,
  type = 'button',
  className = '',
  children,
  ...rest
}: ProtoButtonProps) {
  const classes = [
    'btn',
    VARIANT_CLASS[variant] || 'btn-primary',
    SIZE_CLASS[size] || '',
    loading ? 'loading' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  )
}
