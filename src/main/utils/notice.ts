import {useDialog} from "naive-ui";
import {h} from "vue";
import {ConfigSettingTypes} from "@/background/types";
export class RuneTips{
  private dig = useDialog()

  public handleContent() {
    const text =
      "①：请先确保英雄联盟客户端符文页，是当前英雄的符文数据。/n " +
      "②：自动符文配置成功后，下次选择此英雄将自动完成符文配置的操作。/n" +
      "③：点击英雄头像，可查看配置的数据。"
    const textList = text.split('/n')
    return textList.map((text: string) => {
      return h('p',
        [text])
    })
  }

  public init(config:ConfigSettingTypes){
    this.dig.info({
      title: '使用提示',
      content: this.handleContent,
      showIcon: true,
      maskClosable: true,
      closable: false,
      autoFocus: false,
      style: 'margin:8px;max-width:334px',
      positiveText: '我已了解',
      negativeText: '下次不再弹出',
      onPositiveClick:  () => {
      },
      onNegativeClick: () => {
        config.warmTips.autoRune = true
        localStorage.setItem('configSetting', JSON.stringify(config))
      }
    })
  }

}

export class MainPageTips{
  private dig = useDialog()

  public handleRankContent() {
    const text =
      "①：点击左上角蓝色标签，切换数据来源。/n " +
      "②：搜索框可以使用简写，比如：ys(亚索)。/n" +
      "③：点击英雄头像，可以查看当前英雄，优势对线或者劣势对线数据。"
    const textList = text.split('/n')
    return textList.map((text: string) => {
      return h('p',
        [text])
    })
  }

  public handleTeammateContent() {
    const text =
      "①：点击玩家头像，可以查看更多数据。/n " +
      "②：所有玩家数据加载完毕后，点击左下角按钮可观大局。/n" +
      "③：游戏结束后，添加的玩家；如再次遇见，会在此页面进行弹窗提示。"
    const textList = text.split('/n')
    return textList.map((text: string) => {
      return h('p',
        [text])
    })
  }

  public init(config:ConfigSettingTypes,tipType:number){
    const curType = tipType === 1 ? 'rankTips' : 'teamTips'
    // @ts-ignore
    if (config.warmTips[curType]) {
      return
    }
    this.dig.info({
      title: '使用提示',
      content: tipType === 1 ? this.handleRankContent:this.handleTeammateContent,
      showIcon: true,
      maskClosable: true,
      closable: false,
      autoFocus: false,
      style: 'margin:8px;max-width:334px',
      positiveText: '我已了解',
      negativeText: '下次不再弹出',
      onPositiveClick:  () => {
      },
      onNegativeClick: () => {
        // @ts-ignore
        config.warmTips[curType] = true
        localStorage.setItem('configSetting', JSON.stringify(config))
      }
    })
  }
}
