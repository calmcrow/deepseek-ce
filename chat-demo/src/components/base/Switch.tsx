import clsx from 'clsx'
import styles from './Switch.module.css'

/** 通用开关：设置页里的「更多人用不到」选项统一用它 */
export const Switch = ({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  ariaLabel: string
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    className={clsx(styles.track, checked && styles.on)}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.knob} />
  </button>
)
