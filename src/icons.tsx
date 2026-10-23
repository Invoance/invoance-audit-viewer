// Inline replacements for the lucide-react icons the viewer uses, so the
// package has zero runtime dependencies besides react. Path data matches
// lucide's 24x24 / stroke-2 geometry.

type IconProps = { className?: string };

function base(props: IconProps, children: React.ReactNode) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={props.className}
        >
            {children}
        </svg>
    );
}

export function Check(props: IconProps) {
    return base(props, <path d="M20 6 9 17l-5-5" />);
}
export function ChevronDown(props: IconProps) {
    return base(props, <path d="m6 9 6 6 6-6" />);
}
export function ChevronLeft(props: IconProps) {
    return base(props, <path d="m15 18-6-6 6-6" />);
}
export function ChevronRight(props: IconProps) {
    return base(props, <path d="m9 18 6-6-6-6" />);
}
export function ChevronUp(props: IconProps) {
    return base(props, <path d="m18 15-6-6-6 6" />);
}
export function X(props: IconProps) {
    return base(
        props,
        <>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </>,
    );
}
export function Plus(props: IconProps) {
    return base(
        props,
        <>
            <path d="M5 12h14" />
            <path d="M12 5v14" />
        </>,
    );
}
export function ListFilter(props: IconProps) {
    return base(
        props,
        <>
            <path d="M3 6h18" />
            <path d="M7 12h10" />
            <path d="M10 18h4" />
        </>,
    );
}
export function Search(props: IconProps) {
    return base(
        props,
        <>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
        </>,
    );
}
export function Calendar(props: IconProps) {
    return base(
        props,
        <>
            <rect width="18" height="18" x="3" y="4" rx="2" />
            <path d="M16 2v4" />
            <path d="M8 2v4" />
            <path d="M3 10h18" />
        </>,
    );
}
/** lucide "box": the target marker in the event column. */
export function Box(props: IconProps) {
    return base(
        props,
        <>
            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
            <path d="m3.3 7 8.7 5 8.7-5" />
            <path d="M12 22V12" />
        </>,
    );
}
export function ShieldCheck(props: IconProps) {
    return base(
        props,
        <>
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
            <path d="m9 12 2 2 4-4" />
        </>,
    );
}
export function User(props: IconProps) {
    return base(
        props,
        <>
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
        </>,
    );
}
export function Activity(props: IconProps) {
    return base(
        props,
        <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />,
    );
}
export function Globe(props: IconProps) {
    return base(
        props,
        <>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
            <path d="M2 12h20" />
        </>,
    );
}
