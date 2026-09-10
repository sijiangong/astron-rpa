<script setup lang="ts">
import { VUE_APP_HELP } from '@/constants'
import { utilsManager } from '@/platform'

import ControlButton from './ControlButton.vue'

function handleHelpInfo() {
  utilsManager.openInBrowser(VUE_APP_HELP)
}
</script>

<template>
  <a-dropdown placement="bottom">
    <ControlButton class="cursor-pointer">
      <rpa-icon name="help-circle" />
    </ControlButton>

    <template #overlay>
      <a-menu>
        <a-menu-item @click="handleHelpInfo">
          {{ $t('helperCenter') }}
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>
