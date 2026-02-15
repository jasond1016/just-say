import type { JSX } from 'react'
import { Mic } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

interface PttCardProps {
  hotkey: string
}

export function PttCard({ hotkey }: PttCardProps): JSX.Element {
  return (
    <Card className="border-[#E9E5FF] bg-[#F5F3FF]">
      <CardContent className="flex items-center justify-between gap-5 p-5">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Mic className="h-[18px] w-[18px] text-[#7C3AED]" />
            <span className="text-base font-semibold text-[#1A1A1A]">Push to Talk</span>
            <Badge className="bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-500">Ready</Badge>
          </div>
          <p className="text-[13px] leading-5 text-[#6B7280]">
            Hold the hotkey to record and transcribe your voice. Text is automatically inserted at
            your cursor position.
          </p>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-1.5">
              <span className="text-lg leading-none font-bold text-[#7C3AED]">24</span>
              <span className="text-xs text-[#9CA3AF]">today</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-lg leading-none font-bold text-[#7C3AED]">1,280</span>
              <span className="text-xs text-[#9CA3AF]">chars</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-center gap-2">
          <div className="flex items-center justify-center rounded-lg border border-[#E5E7EB] bg-white px-5 py-3">
            <span className="text-base font-semibold text-[#374151]">{hotkey}</span>
          </div>
          <span className="text-[11px] text-[#9CA3AF]">Hold to record</span>
        </div>
      </CardContent>
    </Card>
  )
}
