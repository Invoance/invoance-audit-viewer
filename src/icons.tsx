// Inline replacements for the six lucide-react icons the viewer used, so the
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
