<script setup lang="ts">
import { NiceModal } from '@rpa/components'
import { Tooltip } from 'ant-design-vue'

import { SettingCenterModal } from '@/components/SettingCenterModal'
import useUserSettingStore from '@/stores/useUserSetting.ts'

import MessageTip from '../MesssageTip/Index.vue'
import Updater from './Updater.vue'
import ControlButton from './ControlButton.vue'
import Help from './Help.vue'
import UserInfo from './UserInfo.vue'

interface HeaderControlProps {
  setting?: boolean
  control?: boolean
  message?: boolean
  userInfo?: boolean
}

// 控制按钮显示
const props = withDefaults(defineProps<HeaderControlProps>(), ({
  setting: true,
  control: true,
  message: true,
  userInfo: true,
}))

useUserSettingStore()

function handleOpenSetting() {
  NiceModal.show(SettingCenterModal)
}
</script>

<template>
  <Updater />

  <Help />

  <Tooltip v-if="props.setting" :title="$t('setting')">
    <ControlButton @click="handleOpenSetting">
      <rpa-icon name="setting" />
    </ControlButton>
  </Tooltip>

  <ControlButton v-if="props.message">
    <MessageTip />
  </ControlButton>
  <ControlButton v-if="props.userInfo">
    <UserInfo />
  </ControlButton>
</template>
