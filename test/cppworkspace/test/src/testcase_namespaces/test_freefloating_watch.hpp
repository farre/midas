#pragma once
#include <string>


namespace freefloating_watch {
struct AppState;

struct Title {
  std::string title;
  bool needs_update;
};

struct Window {
  int w, h;
  int x, y;
  Title title;
  AppState *app_state;
};

struct Widget {
  Widget(int w, int h, int x, int y, AppState *app_state);
  int w, h, x, y;
  AppState *app_state;
};

struct AppState {
  AppState(int win_width, int win_height, std::string title, int* children);
  Window window;
  Widget *widget;
  int* p_child_identifiers = nullptr;
};

void update_title(Title &title, std::string new_title);
void update_window(Window &window);
void do_app_stuff(AppState *state);

void main();
} // namespace freefloating_watch
