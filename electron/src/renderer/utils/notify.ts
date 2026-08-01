export type NotifySeverity = 'info' | 'warning' | 'error';

export type Notify = (message: string, severity?: NotifySeverity) => void;
