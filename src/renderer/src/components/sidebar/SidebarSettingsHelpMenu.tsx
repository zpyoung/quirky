import React, { useState } from 'react'
import {
  CircleHelp,
  ExternalLink,
  Github,
  Keyboard,
  Loader2,
  RefreshCw,
  RotateCw,
  School,
  Settings
} from 'lucide-react'
import { toast } from 'sonner'
import logo from '../../../../../resources/logo.svg'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { showOnboardingFromRenderer } from '../onboarding/show-onboarding-event'
import { SetupGuideProgressRing } from '../setup-guide/SetupGuideProgressRing'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'
import { translate } from '@/i18n/i18n'
import { getUpdateCheckClickOptions, getUpdateCheckHint } from '@/lib/update-check-click-options'

const GITHUB_URL = 'https://github.com/zpyoung/quirky'
const NO_UPDATE_CHECK_MODIFIERS = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
}

function openExternalUrl(url: string): void {
  void window.api.shell.openUrl(url)
}

function ExternalMenuItem({
  label,
  url,
  icon
}: {
  label: string
  url: string
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={() => openExternalUrl(url)}>
      {icon}
      {label}
      <ExternalLink className="ml-auto size-3 text-muted-foreground" />
    </DropdownMenuItem>
  )
}

export function SidebarSettingsHelpMenu(): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const setupProgress = useSetupGuideProgress(true, false, false)

  const settingsShortcut = useShortcutKeyDetails('app.settings')
  const [menuOpen, setMenuOpen] = useState(false)
  const [isRestartingQuirky, setIsRestartingQuirky] = useState(false)
  const lastShowOnboardingAtRef = React.useRef(0)
  const updateCheckModifiersRef = React.useRef(NO_UPDATE_CHECK_MODIFIERS)
  const mountedRef = useMountedRef()
  const updateCheckHint = getUpdateCheckHint()

  const showMilestones =
    setupProgress.ready && setupProgress.coreDoneCount < setupProgress.coreTotal

  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open)
    updateCheckModifiersRef.current = NO_UPDATE_CHECK_MODIFIERS
  }

  const handleShowOnboarding = (): void => {
    const now = Date.now()
    if (now - lastShowOnboardingAtRef.current < 500) {
      return
    }
    lastShowOnboardingAtRef.current = now
    void showOnboardingFromRenderer()
  }

  const handleRestartQuirky = (): void => {
    if (isRestartingQuirky) {
      return
    }
    setIsRestartingQuirky(true)
    toast.info(
      translate('auto.components.sidebar.SidebarSettingsHelpMenu.5161eef55d', 'Restarting Quirky…')
    )
    void window.api.app.restart().catch((error) => {
      if (mountedRef.current) {
        setIsRestartingQuirky(false)
        toast.error(
          translate(
            'auto.components.sidebar.SidebarSettingsHelpMenu.4e8f5710d3',
            "Couldn't restart Quirky."
          ),
          {
            description: error instanceof Error ? error.message : undefined
          }
        )
      }
    })
  }

  const openShortcutsSettings = (): void => {
    openSettingsTarget({ pane: 'shortcuts', repoId: null })
    openSettingsPage()
  }

  const handleCheckForUpdatesPointerDown = (event: React.PointerEvent): void => {
    updateCheckModifiersRef.current = {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey
    }
  }

  const handleCheckForUpdates = (): void => {
    const modifiers = updateCheckModifiersRef.current
    updateCheckModifiersRef.current = NO_UPDATE_CHECK_MODIFIERS
    void window.api.updater.check(getUpdateCheckClickOptions(modifiers))
  }

  const openMilestones = (): void => {
    openModal('setup-guide', {})
  }

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={translate(
              'auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998',
              'Settings'
            )}
            className="text-muted-foreground"
            onClick={openSettingsPage}
          >
            <Settings className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="flex items-center gap-1.5">
          {translate('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')}
          {settingsShortcut.keys.length > 0 ? (
            <ShortcutKeyCombo
              keys={settingsShortcut.keys}
              doubleTap={settingsShortcut.doubleTap}
              className="gap-0.5"
              keyCapClassName="min-w-0 border-background/20 bg-background/10 px-1 py-0 text-[10px] text-background shadow-none"
              separatorClassName="text-[10px] text-background/70"
            />
          ) : null}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={translate(
                  'auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c',
                  'Help'
                )}
                className="text-muted-foreground"
              >
                <CircleHelp className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c', 'Help')}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-52">
          <DropdownMenuItem onSelect={openShortcutsSettings}>
            <Keyboard className="size-3.5" />
            {translate(
              'auto.components.sidebar.SidebarSettingsHelpMenu.e565171a7c',
              'Keyboard Shortcuts'
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {showMilestones ? (
            <DropdownMenuItem onSelect={openMilestones}>
              <img
                src={logo}
                alt=""
                aria-hidden="true"
                className="size-3.5 object-contain invert opacity-55 dark:invert-0"
              />
              {translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.f8a2c91d4e',
                'Milestones'
              )}
              <SetupGuideProgressRing
                done={setupProgress.coreDoneCount}
                total={setupProgress.coreTotal}
                sizeClassName="size-4"
                className="ml-auto"
              />
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="whitespace-nowrap"
            onClick={handleShowOnboarding}
            onSelect={handleShowOnboarding}
          >
            <School className="size-3.5" />
            {translate('auto.components.sidebar.SidebarSettingsHelpMenu.b7e4d2a19c', 'Onboarding')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <ExternalMenuItem
            label={translate(
              'auto.components.sidebar.SidebarSettingsHelpMenu.5687ab246a',
              'GitHub'
            )}
            url={GITHUB_URL}
            icon={<Github className="size-3.5" />}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
            onPointerDown={handleCheckForUpdatesPointerDown}
            onSelect={handleCheckForUpdates}
            title={updateCheckHint}
          >
            {updateStatus.state === 'checking' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {translate(
              'auto.components.sidebar.SidebarSettingsHelpMenu.29c56f30ee',
              'Check for Updates'
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleRestartQuirky} disabled={isRestartingQuirky}>
            <RotateCw className="size-3.5" />
            {translate(
              'auto.components.sidebar.SidebarSettingsHelpMenu.ad3d3ed7f1',
              'Restart Quirky'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
