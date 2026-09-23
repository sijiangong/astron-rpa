import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import { join } from 'node:path'

import { app, dialog, shell } from 'electron'

import { toUnicode } from '../common'

import { mainToRender } from './event'
import { extract7z } from './file'
import logger from './log'
import { appWorkPath, confPath, pythonExe, resourcePath } from './path'
import { getMainWindow } from './window'
import { envJson } from './env'

process.on('uncaughtException', (err) => {
  logger.error(`uncaughtException: ${err.message}`)
})

function sendToRender(message: string, percent: number) {
  const unicodeMessage = `{"type":"sync","msg":{"msg":"${toUnicode(message)}","step":${percent}}}`
  mainToRender('scheduler-event', unicodeMessage, undefined, true)
}

/**
 * 通用重试封装。
 * Windows 上文件/目录可能被杀软、索引等进程短暂占用，产生 EPERM/EBUSY 等瞬时失败，
 * 退避重试可避免“解压成果已存在但重命名失败”导致的启动卡死。
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5, baseDelayMs = 800): Promise<T> {
  let lastError: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    }
    catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      logger.warn(`[重试 ${i}/${attempts}] ${label} 失败${code ? ` (${code})` : ''}: ${(error as Error)?.message}`)
      if (i < attempts) {
        await new Promise(resolve => setTimeout(resolve, baseDelayMs * i))
      }
    }
  }
  throw lastError
}

/**
 * 将临时目录移动到目标目录。
 * 优先 rename（带重试）；仍失败则退化为“递归复制 + 删除源”，确保解压成果不白费。
 */
async function moveDirWithRetry(srcDir: string, destDir: string): Promise<void> {
  try {
    await withRetry(() => fs.rename(srcDir, destDir), `重命名目录 ${srcDir} -> ${destDir}`)
    return
  }
  catch (error) {
    logger.warn(`重命名目录最终失败，改用「复制+删除」兜底: ${(error as Error)?.message}`)
  }
  await withRetry(() => fs.cp(srcDir, destDir, { recursive: true }), `复制目录 ${srcDir} -> ${destDir}`)
  await withRetry(() => fs.rm(srcDir, { recursive: true, force: true }), `删除临时目录 ${srcDir}`)
}

/**
 * 路径是否存在
 */
async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false)
}

/**
 * 结束所有「可执行文件位于指定目录下」的进程。
 *
 * 覆盖安装、或上次被强杀后，本应用启动的 python / route / picker 等子进程可能残留，
 * 它们会锁住 python_core 下的 dll，使目录无法清理或替换（EPERM）。
 * 这些孤儿进程属于本应用，结束它们是安全的；本进程的可执行文件不在该目录下，不会被误伤。
 *
 * @returns 结束的进程数量
 */
async function killProcessesUnderDir(dirPath: string): Promise<number> {
  if (process.platform !== 'win32') {
    logger.warn('非 Windows 平台暂不支持按目录结束占用进程')
    return 0
  }

  // 用 -EncodedCommand 传脚本，彻底绕开引号/换行在 cmd 下的转义问题
  const escapedDir = dirPath.replace(/'/g, '\'\'')
  const script = [
    `$target = '${escapedDir}';`,
    '$killed = 0;',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase) } |',
    'ForEach-Object {',
    '  try {',
    '    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop;',
    '    Write-Output ("killed " + $_.ProcessId + " " + $_.ExecutablePath);',
    '    $killed++',
    '  } catch { }',
    '};',
    'Write-Output ("count=" + $killed)',
  ].join(' ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  return new Promise<number>((resolve) => {
    exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      (error, stdout) => {
        if (error) {
          logger.error(`结束占用进程失败: ${error.message}`)
          resolve(0)
          return
        }
        const output = stdout.trim()
        const match = output.match(/count=(\d+)/)
        const killed = match ? Number(match[1]) : 0
        if (killed > 0)
          logger.warn(`已结束 ${killed} 个占用进程:\n${output}`)
        resolve(killed)
      },
    )
  })
}

/**
 * 强制删除目录；被占用（EPERM/EBUSY）时先结束占用进程再重试一次。
 * @returns 是否已删除（目录本来就不存在也算成功）
 */
async function removeDirForce(dirPath: string, label: string): Promise<boolean> {
  try {
    await withRetry(() => fs.rm(dirPath, { recursive: true, force: true }), label, 3, 500)
    return true
  }
  catch (error) {
    logger.warn(`${label} 失败，尝试结束占用进程后重试: ${(error as Error)?.message}`)
  }

  const killed = await killProcessesUnderDir(appWorkPath)
  if (killed === 0) {
    logger.error(`${label} 失败，且未发现可结束的占用进程: ${dirPath}`)
    return false
  }

  try {
    await withRetry(() => fs.rm(dirPath, { recursive: true, force: true }), label, 3, 500)
    return true
  }
  catch (error) {
    logger.error(`${label} 在结束占用进程后仍失败: ${(error as Error)?.message}`)
    return false
  }
}

/**
 * 让已存在的目录「让位」，供新目录顶上。
 *
 * 优先改名旁置（原子的元数据操作，目录内部文件被占用时通常仍能成功），
 * 而不是直接递归删除——删除是破坏性操作，一旦中途失败就会留下“删了一半、
 * 既起不来又无法自动恢复”的坏死环境（曾导致客户端启动失败且必须手工清理）。
 * 改名失败时才结束占用进程重试，仍失败则抛错；此时旧环境保持完整。
 *
 * @returns 是否真的旁置了（目录原本不存在时返回 false）
 */
async function retireExistingDir(outputDir: string, backupDir: string): Promise<boolean> {
  if (!await pathExists(outputDir))
    return false

  // 清理历史遗留的备份，否则改名会因目标已存在而失败
  if (await pathExists(backupDir)) {
    if (!await removeDirForce(backupDir, '清理历史备份目录'))
      throw new Error(`历史备份目录被占用，无法清理: ${backupDir}`)
  }

  // 首选：改名旁置（原子的元数据操作，且不会破坏内容）
  try {
    await withRetry(() => fs.rename(outputDir, backupDir), '旁置旧环境', 3, 500)
    logger.info(`旧环境已旁置为: ${backupDir}`)
    return true
  }
  catch (error) {
    logger.warn(`旁置旧环境失败，尝试结束占用进程后重试: ${(error as Error)?.message}`)
  }

  if (await killProcessesUnderDir(appWorkPath) > 0) {
    try {
      await withRetry(() => fs.rename(outputDir, backupDir), '旁置旧环境', 3, 500)
      logger.info(`旧环境已旁置为: ${backupDir}`)
      return true
    }
    catch (error) {
      logger.warn(`结束占用进程后仍无法旁置: ${(error as Error)?.message}`)
    }
  }

  // 退而求其次：直接删除旧环境。此时新环境已在临时目录中就绪，不存在“删了一半没得用”的风险。
  logger.warn('改为直接删除旧环境')
  if (!await removeDirForce(outputDir, '删除旧环境'))
    throw new Error(`旧环境既无法旁置也无法删除（可能仍被占用）: ${outputDir}`)

  return false
}

// 应用是否正在关闭（关闭过程中引擎退出属正常，不应弹失败提示）
let isShuttingDown = false

// 引擎上报的最后一条告警文案，用于启动失败弹窗的正文（避免用户还要去翻日志）
let lastAlertMessage = ''

/**
 * 启动失败时给用户可见的提示。
 * 之前只写日志，用户只会看到进度条停在一处、无从判断；这里弹窗并提供「打开日志目录」。
 */
async function notifyLaunchFailure(message: string, detail?: string): Promise<void> {
  const logDir = join(appWorkPath, 'logs')
  logger.error(`[启动失败] ${message}${detail ? ` | ${detail}` : ''}`)

  if (isShuttingDown)
    return

  const options = {
    type: 'error' as const,
    title: '启动失败',
    message,
    detail: `${detail ? `${detail}\n\n` : ''}日志目录：${logDir}`,
    buttons: ['打开日志目录', '退出应用'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }

  try {
    const win = getMainWindow()
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (response === 0)
      await shell.openPath(logDir)
  }
  catch (error) {
    logger.error(`弹出启动失败提示时出错: ${error}`)
  }

  if (!isShuttingDown)
    app.quit()
}

/**
 * 检查 python envJson.SCHEDULER_NAME 是否正在运行
 */
export function checkPythonRpaProcess() {
  return new Promise((resolve) => {
    // linux 上检测 python 进程中 命令行中包含 envJson.SCHEDULER_NAME 的进程
    if (process.platform !== 'win32') {
      exec(`ps aux | grep "${envJson.SCHEDULER_NAME}"`, (error, stdout) => {
        if (error) {
          return resolve(false)
        }
        const isRunning = stdout.trim() !== ''
        resolve(isRunning)
      })
    }
    else {
      exec('tasklist /v /fi "imagename eq python.exe"', (error, stdout) => {
        if (error) {
          logger.error(`tasklist error: ${error}`)
          return resolve(false)
        }
        const isRunning = stdout.includes(envJson.SCHEDULER_NAME)
        resolve(isRunning)
      })
    }
  })
}

/**
 * 启动服务
 */
export async function startServer() {
  // 查看是否已经启动 envJson.SCHEDULER_NAME
  const isRunning = await checkPythonRpaProcess()
  if (isRunning) {
    logger.info(`${envJson.SCHEDULER_NAME} is running`)
    return
  }

  logger.info('正在启动服务')
  sendToRender('正在启动服务', 90)

  // 清理上一次运行遗留的告警文案，避免弹窗复用到过期信息
  lastAlertMessage = ''

  const rpaSetup = exec(
    `"${pythonExe}" -m ${envJson.SCHEDULER_NAME} --conf="${confPath}"`,
    { cwd: appWorkPath },
    (error) => {
      if (error) {
        logger.error(`${envJson.SCHEDULER_NAME} error: ${error}`)
      }
    }
  )

  rpaSetup.stdout?.on('data', (data) => msgFilter(data.toString()))

  rpaSetup.stderr?.on('data', (data) => {
    logger.info(`${envJson.SCHEDULER_NAME} stderr: ${data.toString()}`)
  })

  rpaSetup.on('close', (code) => {
    if (code === 0) {
      logger.info(`${envJson.SCHEDULER_NAME} exited successfully.`)
      return
    }
    logger.error(`${envJson.SCHEDULER_NAME} exited with error code: ${code}`)
    // 非正常退出且非应用关闭时，给用户明确提示（否则界面会停在启动进度上）
    if (!isShuttingDown) {
      void notifyLaunchFailure(
        'RPA 引擎启动失败，客户端无法正常工作',
        lastAlertMessage || `进程退出码：${code}，详情见日志`,
      )
    }
  })

  rpaSetup.on('error', (error) => {
    logger.error(`Failed to start ${envJson.SCHEDULER_NAME}: ${error.message}`)
  })
}

/**
 * 关闭所有子进程
 */
export function closeSubProcess() {
  isShuttingDown = true
  return new Promise<void>((resolve) => {
    exec(
      `"${pythonExe}" -m ${envJson.SCHEDULER_NAME} --stop="True"`,
      { cwd: appWorkPath },
      (error) => {
        if (error) {
          logger.error(`${envJson.SCHEDULER_NAME} closeSubProcess error: ${error}`)
        } else {
          logger.info(`${envJson.SCHEDULER_NAME} closeSubProcess success`)
        }
        resolve()
      }
    )
  })
}

/**
 * 消息过滤器，处理从Python进程接收到的消息
 * @param msg - 从Python进程输出的原始消息字符串
 */
function msgFilter(msg: string) {
  const win = getMainWindow()
  // 匹配以 ||emit|| 开头的字符串
  const match = msg.match(/\|\|emit\|\|(.*)/)
  if (match && win) {
    // 发送到渲染进程
    const message = match[1].trim().replaceAll('"', '')
    logger.info(`${envJson.SCHEDULER_NAME} message: `, message)
    rememberAlert(message)
    win.webContents.send('scheduler-event', message)
  }
}

/**
 * 记录引擎上报的告警文案（||emit|| 的 payload 是 JSON 的 base64），
 * 供启动失败弹窗作为正文使用，用户不必再翻日志
 */
function rememberAlert(message: string) {
  try {
    const parsed = JSON.parse(Buffer.from(message, 'base64').toString('utf-8'))
    if (parsed?.type === 'alert' && parsed?.msg?.msg) {
      lastAlertMessage = parsed.msg.msg
    }
  }
  catch {
    // 非 base64 JSON 的消息（如组件更新进度）忽略即可
  }
}

/**
 * 检查资源目录中需要解压的Python包
 * @returns 需要解压的压缩包文件名数组
 */
async function checkNeedExtractPythonPackage() {
  if (process.platform === 'win32') {
    const fileNames = await fs.readdir(resourcePath)
    return fileNames.filter(fileName => fileName.endsWith('.7z'))
  }
  logger.info('No python package in resources for non-windows platform')
  return []
}

/**
 * 读取哈希文件内容
 * @param hashFilePath - 哈希文件路径（通常以.sha256.txt结尾）
 * @returns 哈希文件中的哈希值字符串
 */
async function readHashFile(hashFilePath: string): Promise<string> {
  try {
    const hashContent = await fs.readFile(hashFilePath, 'utf-8')
    return hashContent.trim()
  } catch (error) {
    logger.error(`读取hash文件失败: ${hashFilePath}`, error)
    throw error
  }
}

/**
 * 检查单个文件是否需要重新解压
 * @param packageFile - 压缩包文件名
 * @returns 是否需要重新解压
 * */
async function checkSingleFile(packageFile: string): Promise<boolean> {
  const archiveName = packageFile.replace('.7z', '')
  const archivePath = join(appWorkPath, archiveName)
  const hashFileName = `${packageFile}.sha256.txt`
  const resourceHashPath = join(resourcePath, hashFileName)
  const appWorkHashPath = join(appWorkPath, hashFileName)

  logger.info(`检查文件: ${packageFile}`)

  try {
    // 1. 检查资源目录中的hash文件是否存在
    await fs.access(resourceHashPath)

    // 2. 并行检查解压文件和用户数据目录中的hash文件是否存在
    const [archiveExists, hashFileExists] = await Promise.all([
      fs.access(archivePath).then(() => true).catch(() => false),
      fs.access(appWorkHashPath).then(() => true).catch(() => false)
    ])

    // 3. 如果解压文件不存在，需要重新解压
    if (!archiveExists) {
      logger.warn(`解压文件不存在: ${packageFile}`)
      return true
    }

    // 4. 如果用户数据目录中的hash文件不存在，需要重新解压
    if (!hashFileExists) {
      logger.warn(`用户数据目录hash文件不存在: ${packageFile}`)
      return true
    }

    // 5. 并行读取两个hash文件的内容
    const [resourceHash, appWorkHash] = await Promise.all([
      readHashFile(resourceHashPath),
      readHashFile(appWorkHashPath)
    ])

    // 6. 如果任何一个hash文件内容为空，需要重新解压
    if (!resourceHash || !appWorkHash) {
      logger.warn(`hash文件内容为空: ${packageFile}`)
      return true
    }

    // 7. 比较hash值，如果不匹配则需要重新解压
    if (resourceHash !== appWorkHash) {
      logger.warn(`hash不匹配: ${packageFile}`)
      return true
    } else {
      logger.info(`hash验证通过: ${packageFile}`)
    }

    return false
  } catch (error) {
    logger.error(`检查解压文件失败: ${packageFile}`, error)
    return true
  }
}

/**
 * 检查并清理已解压的文件，根据哈希验证结果确定需要重新解压的文件列表
 * @param packageFiles - 需要检查的压缩包文件名数组
 * @returns 需要重新解压的文件名数组
 */
async function checkAndCleanExtractedFiles(packageFiles: string[]): Promise<string[]> {
  const needExtractFiles: string[] = []

  for (const packageFile of packageFiles) {
    const needExtract = await checkSingleFile(packageFile)
    if (needExtract) {
      needExtractFiles.push(packageFile)
    }
  }

  logger.info(`需要重新解压的文件数量: ${needExtractFiles.length}`)
  return needExtractFiles
}

/**
 * 复制单个文件
 * @param fileName - 文件名
 * @returns 复制结果
 */
async function copySingleFile(fileName: string): Promise<boolean> {
  const sourcePath = join(resourcePath, fileName)
  const targetPath = join(appWorkPath, fileName)

  try {
    // 检查源文件是否存在
    await fs.access(sourcePath)
    logger.info(`复制文件: ${fileName}`)
    await fs.copyFile(sourcePath, targetPath)
    return true
  } catch (error) {
    logger.error(`复制文件失败: ${fileName}`, error)
    throw error
  }
}

/**
 * 确保用户数据目录存在
 */
async function ensureAppWorkPathExists(): Promise<void> {
  try {
    await fs.access(appWorkPath)
  } catch {
    logger.info(`创建用户数据目录: ${appWorkPath}`)
    await fs.mkdir(appWorkPath, { recursive: true })
  }
}

/**
 * 启动后端服务的主入口函数
 */
export async function startBackend() {
  if (globalThis.serverRunning)
    return

  sendToRender('正在初始化', 10)

  // 检查 python envJson.SCHEDULER_NAME 是否正在运行
  const isRunning = await checkPythonRpaProcess()
  if (isRunning) {
    logger.info('rpa is already running')
    return
  }

  // 安装资源目录下的需要解压的 python 包
  const packageFiles = await checkNeedExtractPythonPackage()

  // 如果没有需要处理的包，直接启动服务
  if (packageFiles.length === 0) {
    logger.info('没有需要处理的python包')
    startServer()
    return
  }

  logger.info(`发现需要处理的python包: ${packageFiles.join(', ')}`)

  // 检查是否有需要解压的 python 包（比对 packageFiles 与 appWorkPath 下的文件 hash 是否一致）
  const needExtractFiles = await checkAndCleanExtractedFiles(packageFiles)

  // 如果没有需要解压的文件，直接启动服务
  if (needExtractFiles.length === 0) {
    logger.info('所有python包都已正确解压，无需重新解压')
    startServer()
    return
  }

  await ensureAppWorkPathExists()

  logger.info(`需要解压的文件: ${needExtractFiles.join(', ')}`)

  let preStep = 30;
  const singlePercentStep = (90 - preStep) / needExtractFiles.length;
  sendToRender('正在解压Python包', preStep)

  // 解压所有文件。
  // 注意：之前直接忽略 allSettled 结果，导致失败时无任何日志、界面卡在 90% 无从排查，这里必须记录失败原因。
  const extractResults = await Promise.allSettled(needExtractFiles.map(file => extractAndCleanFile(file, (percent) => {
    const newStep = preStep + (percent / 100 * singlePercentStep);
    sendToRender('解压中...', newStep)
  })))

  extractResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(`解压/安装失败: ${needExtractFiles[index]}`, result.reason)
    }
  })

  // 校验关键产物是否就位（缺 python.exe 时引擎必然启动失败）
  const extractFailed = extractResults.some(result => result.status === 'rejected')
  const envMissing = await fs.access(pythonExe).then(() => false).catch(() => true)

  // 环境不可用时必须给用户明确提示，而不是让进度条静默停在 90%
  if (extractFailed || envMissing) {
    await notifyLaunchFailure(
      'Python 运行环境初始化失败，客户端无法启动',
      envMissing ? `未找到：${pythonExe}` : 'Python 运行环境解压/安装失败',
    )
    return
  }

  logger.info(`python 运行环境就绪: ${pythonExe}`)

  startServer()
}

/**
 * 解压单个文件并清理压缩文件
 * @param file - 需要解压的文件名
 */
async function extractAndCleanFile(fileName: string, percentCallback: (percent: number) => void): Promise<void> {
  const archivePath = join(resourcePath, fileName)
  const outputDir = join(appWorkPath, fileName.replace('.7z', ''))
  const tempOutputDir = `${outputDir}.temp`
  const backupDir = `${outputDir}.old`

  // 1. 只清临时目录。旧环境此刻完全不动——这是「先拿到可用的新环境、再替换」的前提，
  //    否则清理一旦中途失败，旧环境就被删掉一半，变成既起不来又无法自动恢复的坏死状态。
  if (!await removeDirForce(tempOutputDir, '清理临时目录')) {
    throw new Error(`临时目录被占用，无法清理: ${tempOutputDir}`)
  }

  // 2. 解压到临时目录（此步成功前不改动旧环境）
  logger.info(`开始解压到临时目录: ${tempOutputDir}`)
  await extract7z(archivePath, tempOutputDir, percentCallback)

  // 3. 让旧环境让位：优先改名旁置，避免直接递归删除
  const movedAside = await retireExistingDir(outputDir, backupDir)

  // 4. 新环境顶上（带重试 + 复制兜底）
  logger.info(`重命名为目标目录: ${outputDir}`)
  try {
    await moveDirWithRetry(tempOutputDir, outputDir)
  }
  catch (error) {
    // 替换失败时尽力把旁置的旧环境还原，避免新旧都没有
    if (movedAside) {
      logger.warn(`启用新环境失败，尝试还原旧环境: ${(error as Error)?.message}`)
      await fs.rename(backupDir, outputDir)
        .catch(restoreError => logger.error(`还原旧环境失败: ${restoreError}`))
    }
    throw error
  }

  // 5. 复制 hash 文件
  await copySingleFile(`${fileName}.sha256.txt`)

  // 6. 尽力清理旁置的旧环境；失败不影响启动，仅占磁盘
  if (movedAside) {
    await fs.rm(backupDir, { recursive: true, force: true })
      .catch(error => logger.warn(`清理旁置旧环境失败，可稍后手动删除 ${backupDir}: ${error}`))
  }
}
