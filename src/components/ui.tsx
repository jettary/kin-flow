'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  ArrowUp,
  ArrowDown,
  House,
  ChartNoAxesCombined,
  Wallet,
  Ellipsis,
  Plus,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Lock,
  Search,
  SlidersHorizontal,
  WifiOff,
  RefreshCw,
  LogOut,
  Users,
  Settings,
  CreditCard,
  Landmark,
  ShoppingBasket,
  Utensils,
  Car,
  Heart,
  Film,
  ShoppingBag,
  Plane,
  BookOpen,
  LayoutGrid,
  Briefcase,
  Laptop,
  Gift,
  Coffee,
  Zap,
  Leaf,
  MoreHorizontal,
  Sun,
  Moon,
  Monitor,
  Archive,
  Trash2,
  Pencil,
  Copy,
  CheckCircle2,
  AlertCircle,
  type LucideIcon,
} from 'lucide-react';
import { currencyCodes, currencyName, currencyCountry, flag } from '@/lib/money';
const icons: Record<string, LucideIcon> = {
  home: House,
  chart: ChartNoAxesCombined,
  wallet: Wallet,
  more: Ellipsis,
  plus: Plus,
  left: ChevronLeft,
  right: ChevronRight,
  down: ChevronDown,
  check: Check,
  x: X,
  lock: Lock,
  search: Search,
  filter: SlidersHorizontal,
  offline: WifiOff,
  sync: RefreshCw,
  logout: LogOut,
  users: Users,
  settings: Settings,
  card: CreditCard,
  landmark: Landmark,
  basket: ShoppingBasket,
  utensils: Utensils,
  car: Car,
  heart: Heart,
  film: Film,
  bag: ShoppingBag,
  plane: Plane,
  book: BookOpen,
  grid: LayoutGrid,
  briefcase: Briefcase,
  laptop: Laptop,
  gift: Gift,
  coffee: Coffee,
  zap: Zap,
  leaf: Leaf,
  dots: MoreHorizontal,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  archive: Archive,
  trash: Trash2,
  edit: Pencil,
  copy: Copy,
  success: CheckCircle2,
  alert: AlertCircle,
  expense: ArrowUpRight,
  income: ArrowDownLeft,
  transfer: ArrowLeftRight,
  refund: ArrowDownLeft,
  adjustment: SlidersHorizontal,
  up: ArrowUp,
  moveDown: ArrowDown,
};
export function Icon({
  name,
  size = 20,
  ...props
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const C = icons[name] || Wallet;
  return <C size={size} strokeWidth={1.75} aria-hidden="true" {...props} />;
}
export function Empty({
  icon = 'leaf',
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const previous = document.activeElement as HTMLElement;
    d.showModal();
    return () => {
      d.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? 'dialog wide' : 'dialog'}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-header">
          <div>
            <span className="eyebrow">KINFLOW</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function CurrencySelect({
  value,
  onChange,
  disabled = false,
  label = 'Currency',
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [search, setSearch] = useState('');
  const id = useRef('currency-' + Math.random().toString(36).slice(2));
  return (
    <div className="currency-picker">
      <label className="field">
        <span>{label}</span>
        <input
          list={id.current}
          value={search || value}
          onChange={(e) => {
            const v = e.target.value.toUpperCase();
            if (currencyCodes.includes(v)) {
              onChange(v);
              setSearch('');
            } else setSearch(e.target.value);
          }}
          onBlur={() => setSearch('')}
          disabled={disabled}
          autoComplete="off"
          aria-label={label}
          placeholder="Search currency or country"
        />
        <datalist id={id.current}>
          {currencyCodes
            .filter(
              (c) =>
                !search ||
                `${c} ${currencyName(c)} ${currencyCountry(c)}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((c) => (
              <option value={c} key={c}>
                {flag(c)} {currencyName(c)} · {currencyCountry(c)}
              </option>
            ))}
        </datalist>
      </label>
      <small>
        {flag(value)} {currencyName(value)}
      </small>
    </div>
  );
}
export function Privacy({ personal }: { personal: boolean }) {
  return (
    <span className={'privacy ' + (personal ? 'personal' : '')}>
      <Icon name={personal ? 'lock' : 'users'} size={12} />
      {personal ? 'Only you' : 'Shared'}
    </span>
  );
}
export function ErrorMessage({ message }: { message?: string }) {
  return message ? (
    <p className="error" role="alert">
      <Icon name="alert" size={18} />
      {message}
    </p>
  ) : null;
}
export function BusyButton({
  busy,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={busy || props.disabled}>
      {busy ? (
        <>
          <Icon name="sync" className="spin" size={17} /> Saving…
        </>
      ) : (
        children
      )}
    </button>
  );
}
