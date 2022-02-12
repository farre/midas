#include "statics.hpp"
#include "todo.hpp"
namespace statics
{
    int Statics::sk = 42;
    int *Statics::p_sk = new int{142};

    Todo Statics::stodo = Todo{"Static Todo", Date{.day = 4, .month = 2, .year = 2022}};
    Todo *Statics::p_stodo = new Todo{"Static pointer to Todo", Date{.day = 4, .month = 2, .year = 2022}};

    void main() {
        static auto sStatic = new statics::Statics{1337,42, "Static static all the way statics::statics"}; 
        statics::Statics* sOne = new statics::Statics{1,2, "Statics one"};
        statics::Statics* sTwo = new statics::Statics{100,200, "Statics Two"};
        Date d{.day = 20, .month = 2, .year = 2022};
        Todo::post_pone(sTwo->p_stodo, d);
    }
} // namespace statics