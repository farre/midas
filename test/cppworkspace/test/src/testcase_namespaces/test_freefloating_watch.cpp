#include "test_freefloating_watch.hpp"
#include <span>
namespace freefloating_watch {
Widget::Widget(int w, int h, int x, int y, AppState *app_state)
    : w(w), h(h), x(x), y(y), app_state(app_state) {}

AppState::AppState(int win_width, int win_height, std::string title, int* children)
    : window{.w = win_width,
             .h = win_height,
             .x = 0,
             .y = 0,
             .title = {.title = title, .needs_update = false},
             .app_state = nullptr},
             p_child_identifiers(children) {
  this->window.app_state = this;
  this->widget = new Widget{10, 10, 0, 0, this};
}

void update_title(Title &title, std::string new_title) {
  title.title = new_title;
  title.needs_update = true;
}

void update_window(Window &window) {
  update_title(window.title, "Hello world");
  window.x += 10;
  window.y += 100;
}

void do_app_stuff(AppState *state) {
  update_window(state->window);
  state->p_child_identifiers[0] = 0;
  state->p_child_identifiers[5] = 5;
  state->p_child_identifiers[9] = 9;
}
void main() {
  // when in update title, we should be able to lock the watch
  // variable "app_state" to this scope and be able to watch it from `update_title`
  // `update_window` and `do_app_stuff`
  auto children = new int[10];
  auto idx = 0;
  std::span<int> span{children, 10};
  for(auto& i : span) {
    i = idx * (2 + idx);
    idx++;
  }
  auto app_state = new AppState{100, 100, "Foo bar", children};
  do_app_stuff(app_state);
}
} // namespace freefloating_watch