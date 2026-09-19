import {TrayIcon, TrayIconEvent, TrayIconOptions} from '@tauri-apps/api/tray';
import {defaultWindowIcon} from '@tauri-apps/api/app';
import {Menu} from '@tauri-apps/api/menu';
import {exit} from "@tauri-apps/plugin-process";
import {window} from "@tauri-apps/api";
import { MainWindow, RecentMatchWindow } from "./creatWindow.ts";
import {Image} from "@tauri-apps/api/image";

const showMain = (isHide:boolean) => {
  window.Window.getByLabel('mainWindow').then(async (win) => {
    if (!win) return;

    if (isHide) {
      await win.hide();
      return;
    }

    const isVisible = await win.isVisible();
    const isMinimized = await win.isMinimized();

    if (!isVisible) {
      await win.show();
    }

    if (isMinimized) {
      await win.unminimize();
    } else if (isVisible) {
      await win.hide(); // 如果窗口已经显示，则隐藏
    }
  })
}

const openMain = () => {
  window.Window.getByLabel('mainWindow').then(async (win) => {
    if (!win) {
      new MainWindow();
      return;
    }
    if (await win.isMinimized()) {
      await win.unminimize();
    }
    await win.show();
  });
};

const menu = await Menu.new({
  items: [
    {
      id: 'showMain',
      text: '隐藏助手',
      action: () => {
        showMain(true);
      },
    },
    {
      id: 'matchDetail',
      text: '对局详情',
      action: () => {
        window.Window.getByLabel('recentMatchWindow').then(async (win) => {
          if (win === null) {
            await RecentMatchWindow.ensure();
          }else{
            if (await win.isVisible()) {
              win.hide();
            }else {
              win.show();
            }
          }
        })
      },
    },
    {
      id: 'queryMatch',
      text: '我的战绩',
      action: () => {
        openMain();
      },
    },
    {
      id: 'quit',
      text: '退出软件',
      action: () => {
        exit(1);
      },
    },
  ],
});

const leftClick = async (event: TrayIconEvent) => {
  if (event.type === "Click" && event.button==='Left' && event.buttonState==='Down') {
    showMain(false);
  }
}

const options:TrayIconOptions = {
  icon: await defaultWindowIcon() as Image,
  menu,
  menuOnLeftClick: false,
  action:leftClick
};

TrayIcon.new(options);
