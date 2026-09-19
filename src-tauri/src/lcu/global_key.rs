use rdev::{listen, Event, EventType, Key};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

pub fn init_global_keyboard(app: AppHandle) {
    tracing::info!(
        target = "lcu.keyboard",
        "global keyboard listener starting"
    );
    let mut shift_state: bool = false;
    // 捕获全局键盘事件
    if let Err(error) = listen(move |event: Event| callback(event, &mut shift_state, &app)) {
        tracing::error!(
            target = "lcu.keyboard",
            error = ?error,
            "global keyboard listener failed"
        );
    }
}

fn callback(event: Event, shift_state: &mut bool, app: &AppHandle) {
    match event.event_type {
        // 处理按键按下事件
        EventType::KeyPress(key_event) => match key_event {
            Key::ShiftLeft | Key::ShiftRight => handle_shift_press(shift_state), // 同时也支持右侧 Shift
            Key::Tab => handle_show_hide_window(shift_state, app, "recentMatchWindow"),
            _ => (),
        },

        // 处理按键释放事件
        EventType::KeyRelease(key_event) => {
            if (key_event == Key::ShiftLeft || key_event == Key::ShiftRight) && *shift_state {
                // 重置 Shift 键状态
                *shift_state = false;
            }
        }
        _ => (),
    }
}

// 处理 Shift 键按下
fn handle_shift_press(shift_state: &mut bool) {
    if !*shift_state {
        *shift_state = true;
    }
}

// 处理 Shift + Tab
fn handle_show_hide_window(shift_state: &mut bool, app: &AppHandle, win_name: &str) {
    if *shift_state {
        if let Some(win) = app.get_webview_window(win_name) {
            // 检查窗口当前是否可见
            match win.is_visible() {
                Ok(true) => {
                    tracing::debug!(
                        target = "lcu.keyboard",
                        window = win_name,
                        "hiding window"
                    );
                    if let Err(error) = win.hide() {
                        tracing::warn!(
                            target = "lcu.keyboard",
                            window = win_name,
                            error = %error,
                            "hide window failed"
                        );
                    }
                }
                Ok(false) => {
                    tracing::debug!(
                        target = "lcu.keyboard",
                        window = win_name,
                        "showing window"
                    );
                    if let Err(error) = win.show() {
                        tracing::warn!(
                            target = "lcu.keyboard",
                            window = win_name,
                            error = %error,
                            "show window failed"
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        target = "lcu.keyboard",
                        window = win_name,
                        error = %error,
                        "check window visibility failed"
                    );
                }
            }
        } else {
            tracing::info!(
                target = "lcu.keyboard",
                window = win_name,
                "window not present, requesting recovery"
            );
            // 软件可能在对局开始后才启动，或窗口曾被关闭。通知前端按当前
            // LCU session 恢复窗口，而不是只对已存在的窗口做显隐切换。
            let _ = app.emit_to(
                EventTarget::labeled("background"),
                "recoverGameWindow",
                (),
            );
        }
    }
}
