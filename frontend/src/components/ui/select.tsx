'use client'
import * as React from 'react'
import { cn } from '@/lib/utils'

interface SelectProps {
  value?: string
  onValueChange?: (value: string) => void
  children?: React.ReactNode
}

function Select({ value, onValueChange, children }: SelectProps) {
  return <div data-value={value}>{children}</div>
}

function SelectTrigger({ children, className }: { children: React.ReactNode; className?: string }) {
  return <button className={cn('flex items-center border rounded px-3 py-2 w-full', className)}>{children}</button>
}

function SelectValue({ placeholder }: { placeholder?: string }) {
  return <span>{placeholder}</span>
}

function SelectContent({ children }: { children: React.ReactNode }) {
  return <div className="absolute z-10 bg-background border rounded shadow">{children}</div>
}

function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
  return <div data-value={value} className="px-3 py-2 hover:bg-accent cursor-pointer">{children}</div>
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
