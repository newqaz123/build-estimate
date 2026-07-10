"use client"

import { useState, useRef, useEffect } from "react"
import { ChevronRight } from "lucide-react"

interface Props {
  title: string
  subtitle?: string
  defaultOpen?: boolean
  children: React.ReactNode
}

export function CollapsibleSection({ title, subtitle, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const contentRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | undefined>(open ? undefined : 0)

  useEffect(() => {
    if (open) {
      setHeight(contentRef.current?.scrollHeight)
      const timer = setTimeout(() => setHeight(undefined), 200)
      return () => clearTimeout(timer)
    }
    setHeight(contentRef.current?.scrollHeight ?? 0)
    requestAnimationFrame(() => setHeight(0))
  }, [open])

  return (
    <div
      data-od-id={`collapsible-section-${title}`}
      className="elev-raised border border-border rounded-[16px] overflow-hidden"
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-3 text-left text-sm font-semibold bg-muted/30 hover:bg-muted/50 transition-colors"
      >
        <ChevronRight
          className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="flex-1">{title}</span>
        {subtitle && (
          <span className="text-xs font-normal text-muted-foreground ml-auto">{subtitle}</span>
        )}
      </button>
      <div
        ref={contentRef}
        style={{ height: height !== undefined ? `${height}px` : "auto" }}
        className="overflow-hidden transition-[height] duration-200 ease-in-out"
      >
        <div className="p-0">{children}</div>
      </div>
    </div>
  )
}
