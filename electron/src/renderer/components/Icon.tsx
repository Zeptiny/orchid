import type { ComponentType, SVGProps } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock,
  Code,
  Command as CommandIcon,
  Copy,
  Cpu,
  Database,
  Edit2,
  Eye,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Grid,
  Hash,
  Inbox,
  Layers,
  Lock,
  Loader,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sidebar as SidebarIcon,
  Sliders,
  Square,
  Terminal,
  Tool,
  Trash2,
  User,
  X,
  Zap,
} from 'react-feather';

type FeatherIcon = ComponentType<
  SVGProps<SVGSVGElement> & {
    size?: number | string;
    strokeWidth?: number | string;
  }
>;

const ICONS = {
  activity: Activity,
  alert: AlertTriangle,
  alertCircle: AlertCircle,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  circle: Circle,
  clock: Clock,
  code: Code,
  command: CommandIcon,
  copy: Copy,
  cpu: Cpu,
  database: Database,
  edit: Edit2,
  eye: Eye,
  fileText: FileText,
  folder: Folder,
  gitBranch: GitBranch,
  globe: Globe,
  grid: Grid,
  hash: Hash,
  inbox: Inbox,
  layers: Layers,
  lock: Lock,
  loader: Loader,
  menu: Menu,
  messageSquare: MessageSquare,
  moreHorizontal: MoreHorizontal,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  settings: Settings,
  sidebar: SidebarIcon,
  sliders: Sliders,
  square: Square,
  terminal: Terminal,
  tool: Tool,
  trash: Trash2,
  user: User,
  x: X,
  zap: Zap,
} satisfies Record<string, FeatherIcon>;

export type IconName = keyof typeof ICONS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number | string;
  label?: string;
}

export function Icon({ name, size = 16, label, className = '', ...props }: IconProps) {
  const Component = ICONS[name];

  return (
    <Component
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`shrink-0 ${className}`}
      focusable="false"
      size={size}
      strokeWidth={1.8}
      {...props}
    />
  );
}
